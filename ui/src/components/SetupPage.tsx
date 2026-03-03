import { useState } from 'react';

interface Props {
  onComplete: () => void;
}

export function SetupPage({ onComplete }: Props) {
  const [subnet, setSubnet] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!subnet.match(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/)) {
      setError('Enter a valid CIDR, e.g. 192.168.1.0/24');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnet }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? 'Setup failed');
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="setup-page">
      <div className="setup-card">
        <div className="setup-logo">
          <span className="setup-logo-icon">◉</span>
          <h1>WhatsLive</h1>
        </div>
        <p className="setup-tagline">
          Know your office IT is working before employees tell you it's broken.
        </p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="subnet">Network to scan (CIDR)</label>
          <input
            id="subnet"
            type="text"
            placeholder="192.168.1.0/24"
            value={subnet}
            onChange={(e) => setSubnet(e.target.value)}
            disabled={loading}
            autoFocus
          />
          {error && <p className="setup-error">{error}</p>}
          <button type="submit" disabled={loading || !subnet}>
            {loading ? 'Starting scan…' : 'Start Scanning'}
          </button>
        </form>
      </div>
    </div>
  );
}
