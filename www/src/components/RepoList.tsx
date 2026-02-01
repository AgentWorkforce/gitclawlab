import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

interface Repository {
  id: number
  name: string
  full_name: string
  description: string
  owner: { login: string }
  default_branch: string
  updated_at: string
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px'
  },
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
  repoCard: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '6px',
    padding: '16px 20px',
    transition: 'border-color 0.2s'
  },
  repoName: {
    color: '#58a6ff',
    fontSize: '16px',
    fontWeight: '600',
    textDecoration: 'none',
    display: 'block',
    marginBottom: '8px'
  },
  repoDesc: {
    color: '#8b949e',
    fontSize: '14px',
    marginBottom: '12px'
  },
  repoMeta: {
    display: 'flex',
    gap: '16px',
    fontSize: '12px',
    color: '#8b949e'
  },
  loading: {
    color: '#8b949e',
    textAlign: 'center' as const,
    padding: '40px'
  },
  error: {
    background: '#3d1c1c',
    border: '1px solid #6e3333',
    color: '#f85149',
    padding: '16px',
    borderRadius: '6px',
    textAlign: 'center' as const
  },
  empty: {
    textAlign: 'center' as const,
    padding: '60px 20px',
    color: '#8b949e'
  }
}

export default function RepoList() {
  const [repos, setRepos] = useState<Repository[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/repos')
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch repositories')
        return res.json()
      })
      .then(data => {
        setRepos(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  if (loading) {
    return <div style={styles.loading}>Loading repositories...</div>
  }

  if (error) {
    return <div style={styles.error}>{error}</div>
  }

  if (repos.length === 0) {
    return (
      <div style={styles.empty}>
        <h2>No repositories yet</h2>
        <p>Push your first Molt AI bot to get started.</p>
      </div>
    )
  }

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.title}>Repositories</h1>
      </div>
      <div style={styles.container}>
        {repos.map(repo => (
          <div key={repo.id} style={styles.repoCard}>
            <Link
              to={`/repo/${repo.owner?.login || 'unknown'}/${repo.name}`}
              style={styles.repoName}
            >
              {repo.full_name || repo.name}
            </Link>
            <p style={styles.repoDesc}>
              {repo.description || 'No description provided'}
            </p>
            <div style={styles.repoMeta}>
              <span>Branch: {repo.default_branch || 'main'}</span>
              <span>Updated: {new Date(repo.updated_at).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
