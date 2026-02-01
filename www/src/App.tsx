import { useState, useEffect } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import RepoList from './components/RepoList'
import DeploymentStatus from './components/DeploymentStatus'
import Billing from './components/Billing'

const styles = {
  container: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: '#0d1117',
    minHeight: '100vh',
    color: '#c9d1d9'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '1px solid #30363d',
    paddingBottom: '20px',
    marginBottom: '30px'
  },
  logo: {
    fontSize: '24px',
    fontWeight: 'bold',
    color: '#58a6ff',
    textDecoration: 'none'
  },
  nav: {
    display: 'flex',
    gap: '20px'
  },
  navLink: {
    color: '#8b949e',
    textDecoration: 'none',
    padding: '8px 16px',
    borderRadius: '6px',
    transition: 'background 0.2s'
  }
}

function App() {
  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <Link to="/" style={styles.logo}>
          GitClawLab
        </Link>
        <nav style={styles.nav}>
          <Link to="/" style={styles.navLink}>Repositories</Link>
          <Link to="/deployments" style={styles.navLink}>Deployments</Link>
          <Link to="/billing" style={styles.navLink}>Billing</Link>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<RepoList />} />
        <Route path="/repo/:owner/:name" element={<RepoDetail />} />
        <Route path="/deployments" element={<DeploymentStatus />} />
        <Route path="/billing" element={<Billing />} />
      </Routes>
    </div>
  )
}

function RepoDetail() {
  const [repo, setRepo] = useState<any>(null)
  const [deploying, setDeploying] = useState(false)
  const [message, setMessage] = useState('')

  const params = window.location.pathname.split('/')
  const owner = params[2]
  const name = params[3]

  useEffect(() => {
    fetch(`/api/repos/${owner}/${name}`)
      .then(res => res.json())
      .then(setRepo)
      .catch(() => setMessage('Failed to load repository'))
  }, [owner, name])

  const triggerDeploy = async () => {
    setDeploying(true)
    setMessage('')
    try {
      const res = await fetch(`/api/repos/${owner}/${name}/deploy`, {
        method: 'POST'
      })
      const data = await res.json()
      if (res.ok) {
        setMessage(`Deployment started: ${data.deploymentId}`)
      } else {
        setMessage(`Error: ${data.error}`)
      }
    } catch {
      setMessage('Failed to trigger deployment')
    }
    setDeploying(false)
  }

  if (!repo) {
    return <div style={{ color: '#8b949e' }}>Loading repository...</div>
  }

  return (
    <div>
      <div style={detailStyles.header}>
        <h1 style={detailStyles.title}>{repo.full_name || `${owner}/${name}`}</h1>
        <button
          onClick={triggerDeploy}
          disabled={deploying}
          style={{
            ...detailStyles.deployBtn,
            opacity: deploying ? 0.6 : 1
          }}
        >
          {deploying ? 'Deploying...' : 'Deploy'}
        </button>
      </div>

      {message && (
        <div style={detailStyles.message}>{message}</div>
      )}

      <div style={detailStyles.info}>
        <div style={detailStyles.infoItem}>
          <span style={detailStyles.label}>Description:</span>
          <span>{repo.description || 'No description'}</span>
        </div>
        <div style={detailStyles.infoItem}>
          <span style={detailStyles.label}>Default Branch:</span>
          <span>{repo.default_branch || 'main'}</span>
        </div>
        <div style={detailStyles.infoItem}>
          <span style={detailStyles.label}>Clone URL:</span>
          <code style={detailStyles.code}>{repo.clone_url}</code>
        </div>
      </div>
    </div>
  )
}

const detailStyles = {
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px'
  },
  title: {
    fontSize: '28px',
    color: '#c9d1d9'
  },
  deployBtn: {
    background: '#238636',
    color: '#fff',
    border: 'none',
    padding: '10px 20px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer'
  },
  message: {
    background: '#161b22',
    border: '1px solid #30363d',
    padding: '12px 16px',
    borderRadius: '6px',
    marginBottom: '20px',
    color: '#58a6ff'
  },
  info: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '6px',
    padding: '20px'
  },
  infoItem: {
    display: 'flex',
    gap: '12px',
    marginBottom: '12px'
  },
  label: {
    color: '#8b949e',
    minWidth: '120px'
  },
  code: {
    background: '#0d1117',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '13px'
  }
}

export default App
