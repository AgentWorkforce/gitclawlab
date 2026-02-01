import { useState, useEffect } from 'react'

interface Deployment {
  id: string
  repo: string
  status: 'pending' | 'running' | 'success' | 'failed'
  created_at: string
  finished_at?: string
  logs?: string[]
}

const styles = {
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px'
  },
  title: {
    fontSize: '24px',
    color: '#c9d1d9'
  },
  refreshBtn: {
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    padding: '8px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px'
  },
  card: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '6px',
    padding: '16px 20px'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px'
  },
  repo: {
    color: '#58a6ff',
    fontSize: '16px',
    fontWeight: '600'
  },
  status: {
    padding: '4px 12px',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: '600',
    textTransform: 'uppercase' as const
  },
  statusPending: {
    background: '#3d3d00',
    color: '#d29922'
  },
  statusRunning: {
    background: '#1c3d5a',
    color: '#58a6ff'
  },
  statusSuccess: {
    background: '#1c3d1c',
    color: '#3fb950'
  },
  statusFailed: {
    background: '#3d1c1c',
    color: '#f85149'
  },
  meta: {
    fontSize: '12px',
    color: '#8b949e',
    marginBottom: '12px'
  },
  logsToggle: {
    background: 'transparent',
    border: 'none',
    color: '#58a6ff',
    cursor: 'pointer',
    fontSize: '13px',
    padding: 0
  },
  logs: {
    background: '#0d1117',
    borderRadius: '6px',
    padding: '12px',
    marginTop: '12px',
    fontFamily: 'monospace',
    fontSize: '12px',
    maxHeight: '200px',
    overflow: 'auto'
  },
  logLine: {
    color: '#8b949e',
    marginBottom: '4px'
  },
  empty: {
    textAlign: 'center' as const,
    padding: '60px 20px',
    color: '#8b949e'
  },
  loading: {
    color: '#8b949e',
    textAlign: 'center' as const,
    padding: '40px'
  }
}

const getStatusStyle = (status: string) => {
  switch (status) {
    case 'pending': return styles.statusPending
    case 'running': return styles.statusRunning
    case 'success': return styles.statusSuccess
    case 'failed': return styles.statusFailed
    default: return {}
  }
}

export default function DeploymentStatus() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())

  const fetchDeployments = () => {
    setLoading(true)
    fetch('/api/deployments')
      .then(res => res.json())
      .then(data => {
        setDeployments(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(() => {
        setDeployments([])
        setLoading(false)
      })
  }

  useEffect(() => {
    fetchDeployments()
    const interval = setInterval(fetchDeployments, 10000)
    return () => clearInterval(interval)
  }, [])

  const toggleLogs = (id: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  if (loading && deployments.length === 0) {
    return <div style={styles.loading}>Loading deployments...</div>
  }

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.title}>Deployments</h1>
        <button onClick={fetchDeployments} style={styles.refreshBtn}>
          Refresh
        </button>
      </div>

      {deployments.length === 0 ? (
        <div style={styles.empty}>
          <h2>No deployments yet</h2>
          <p>Trigger a deployment from a repository page.</p>
        </div>
      ) : (
        <div style={styles.list}>
          {deployments.map(deployment => (
            <div key={deployment.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <span style={styles.repo}>{deployment.repo}</span>
                <span style={{ ...styles.status, ...getStatusStyle(deployment.status) }}>
                  {deployment.status}
                </span>
              </div>
              <div style={styles.meta}>
                <span>Started: {new Date(deployment.created_at).toLocaleString()}</span>
                {deployment.finished_at && (
                  <span> | Finished: {new Date(deployment.finished_at).toLocaleString()}</span>
                )}
              </div>

              {deployment.logs && deployment.logs.length > 0 && (
                <>
                  <button
                    onClick={() => toggleLogs(deployment.id)}
                    style={styles.logsToggle}
                  >
                    {expandedLogs.has(deployment.id) ? 'Hide logs' : 'View logs'}
                  </button>

                  {expandedLogs.has(deployment.id) && (
                    <div style={styles.logs}>
                      {deployment.logs.map((line, i) => (
                        <div key={i} style={styles.logLine}>{line}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
