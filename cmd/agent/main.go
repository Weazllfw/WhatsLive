package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/weazllfw/whatslive/internal/api"
	"github.com/weazllfw/whatslive/internal/db"
	dbpkg "github.com/weazllfw/whatslive/internal/db"
	"github.com/weazllfw/whatslive/internal/discovery"
	"github.com/weazllfw/whatslive/internal/license"
	"github.com/weazllfw/whatslive/internal/notify"
	"github.com/weazllfw/whatslive/internal/poller"
	"github.com/weazllfw/whatslive/internal/state"
	"github.com/weazllfw/whatslive/internal/ws"
)

var (
	flagDB               = flag.String("db", "whatslive.db", "path to SQLite database file")
	flagSubnet           = flag.String("subnet", "", "subnet to scan, e.g. 192.168.1.0/24")
	flagAddr             = flag.String("addr", "", "HTTP listen address (default :8080, overrides bind_addr setting)")
	flagScanOnly         = flag.Bool("scan-only", false, "run one discovery scan, print results, and exit")
	flagInstallService   = flag.Bool("install-service", false, "(Windows) register as a Windows Service and exit")
	flagUninstallService = flag.Bool("uninstall-service", false, "(Windows) remove the Windows Service and exit")
)

func main() {
	flag.Parse()

	// Windows Service install/uninstall helpers (called by the Inno Setup script).
	if err := handleServiceCommands(); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}

	// When running as a Windows Service the SCM manages our lifecycle.
	if isWindowsService() {
	runAsService(func(ctx context.Context) {
		run(ctx, *flagDB, *flagSubnet, *flagAddr)
	})
		return
	}

	// --scan-only: one shot, then exit.
	if *flagScanOnly && *flagSubnet != "" {
		scanAndPrint(*flagDB, *flagSubnet)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown on SIGINT/SIGTERM.
	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		log.Println("shutting down")
		cancel()
	}()

	run(ctx, *flagDB, *flagSubnet, *flagAddr)
}

// run is the main application loop. It opens the database, starts the poller,
// and serves the HTTP + WebSocket API. It exits when ctx is cancelled.
func run(ctx context.Context, dbPath, subnetFlag, addrFlag string) {
	log.Printf("WhatsLive starting, database: %s", dbPath)

	database, err := db.Open(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open database: %v\n", err)
		os.Exit(1)
	}
	defer database.Close()
	log.Println("database migrations applied successfully")

	// Resolve subnet: prefer CLI flag, then settings table.
	activeSubnet := subnetFlag
	if activeSubnet == "" {
		if v, ok := dbpkg.Setting(database, "subnet"); ok {
			activeSubnet = v
		}
	}

	// Resolve bind address: CLI flag > settings table > default.
	bindAddr := "0.0.0.0:8080"
	if addrFlag != "" {
		bindAddr = addrFlag
	} else if v, ok := dbpkg.Setting(database, "bind_addr"); ok && v != "" {
		bindAddr = v
	}

	// License manager — loads any saved key from the database.
	lic, err := license.New(database)
	if err != nil {
		log.Printf("license: init warning: %v (continuing with free tier)", err)
		lic = nil
	}
	if lic != nil {
		log.Printf("license: tier=%s device_limit=%d", lic.Tier(), lic.DeviceLimit())
	}

	// Notification sender.
	notifier := notify.New()

	// State machine + event channel.
	eventCh := make(chan state.Event, 256)
	fsm := state.New(database, eventCh)

	// WebSocket hub.
	hub := api.NewHub()

	// Forward state events to the hub; fire notifications when tier allows.
	go func() {
		for ev := range eventCh {
			log.Printf("state: %s %s → %s", ev.DeviceMAC, ev.OldState, ev.NewState)
			hub.Broadcast(ws.NewEnvelope(ws.TypeStateChange, ws.StateChangePayload{
				DeviceMAC: ev.DeviceMAC,
				State:     ev.NewState,
				At:        ev.At.Format(time.RFC3339),
				LatencyMs: ev.LatencyMs,
			}))

			// Fire webhook/Slack on meaningful transitions.
			if ev.OldState != "" && ev.NewState != ev.OldState {
				webhookURL, _ := dbpkg.Setting(database, "webhook_url")
				slackURL, _   := dbpkg.Setting(database, "slack_webhook_url")
				if webhookURL != "" || slackURL != "" {
					label := ev.DeviceMAC
					if row := database.QueryRow(`SELECT COALESCE(NULLIF(label,''), hostname, mac) FROM devices WHERE mac = ?`, ev.DeviceMAC); row != nil {
						_ = row.Scan(&label)
					}
					go notifier.Send(notify.Config{
						WebhookURL:      webhookURL,
						SlackWebhookURL: slackURL,
					}, ev.DeviceMAC, label, ev.OldState, ev.NewState, ev.At)
				}
			}
		}
	}()

	// onSetup is called when a subnet is submitted via POST /api/setup.
	onSetup := func(newSubnet string) {
		log.Printf("setup: starting poller for subnet %s", newSubnet)
		go poller.Run(ctx, database, newSubnet, fsm, eventCh, hub.Broadcast)
	}

	// Persist subnet from CLI flag so /api/status reflects it.
	if subnetFlag != "" && activeSubnet != "" {
		_ = dbpkg.SetSetting(database, "subnet", activeSubnet)
	}

	// Start poller if we have a subnet.
	if activeSubnet != "" {
		log.Printf("starting poller for subnet %s", activeSubnet)
		go poller.Run(ctx, database, activeSubnet, fsm, eventCh, hub.Broadcast)
	} else {
		log.Println("no subnet configured — open http://" + bindAddr + " to complete setup")
	}

	// HTTP server (non-blocking).
	srv := api.New(database, hub, fsm, onSetup, lic)
	go func() {
		if err := srv.Run(bindAddr); err != nil {
			log.Printf("server error: %v", err)
		}
	}()

	log.Printf("WhatsLive ready — http://%s", bindAddr)
	<-ctx.Done()
}

// scanAndPrint runs one discovery pass, prints results to stdout, and exits.
func scanAndPrint(dbPath, subnet string) {
	database, err := db.Open(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open database: %v\n", err)
		os.Exit(1)
	}
	defer database.Close()

	devices, err := discovery.Run(context.Background(), database, subnet)
	if err != nil {
		fmt.Fprintf(os.Stderr, "discovery error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("\n%-18s  %-17s  %-35s  %s\n", "IP", "MAC", "HOSTNAME", "VENDOR")
	fmt.Printf("%s\n", "------------------------------------------------------------------------------------")
	for _, d := range devices {
		hostname, vendor := d.Hostname, d.Vendor
		if hostname == "" {
			hostname = "(unknown)"
		}
		if vendor == "" {
			vendor = "(unknown)"
		}
		fmt.Printf("%-18s  %-17s  %-35s  %s\n", d.IP, d.MAC, hostname, vendor)
	}
	fmt.Printf("\n%d device(s) found\n", len(devices))
}
