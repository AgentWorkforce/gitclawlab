import { useState, useEffect } from 'react'

interface Plan {
  name: string
  priceMonthly: number
  features: {
    maxRepos: number
    maxDeploymentsPerMonth: number
    support: string
    customDomains?: boolean
    agentSeats?: number
    teamPermissions?: boolean
    auditLogs?: boolean
  }
  stripePriceId: string | null
}

interface PlansResponse {
  plans: {
    free: Plan
    pro: Plan
    team: Plan
  }
}

const styles = {
  container: {
    maxWidth: '900px',
    margin: '0 auto'
  },
  title: {
    fontSize: '28px',
    marginBottom: '8px',
    color: '#c9d1d9'
  },
  subtitle: {
    color: '#8b949e',
    marginBottom: '32px'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '24px'
  },
  card: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '12px',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column' as const
  },
  cardHighlight: {
    background: '#161b22',
    border: '2px solid #238636',
    borderRadius: '12px',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column' as const
  },
  planName: {
    fontSize: '20px',
    fontWeight: '600',
    color: '#c9d1d9',
    marginBottom: '8px'
  },
  price: {
    fontSize: '36px',
    fontWeight: 'bold',
    color: '#c9d1d9'
  },
  priceLabel: {
    fontSize: '14px',
    color: '#8b949e'
  },
  features: {
    listStyle: 'none',
    padding: 0,
    margin: '24px 0',
    flex: 1
  },
  feature: {
    padding: '8px 0',
    color: '#8b949e',
    borderBottom: '1px solid #21262d'
  },
  button: {
    background: '#238636',
    color: '#fff',
    border: 'none',
    padding: '12px 24px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    marginTop: 'auto'
  },
  buttonDisabled: {
    background: '#21262d',
    color: '#8b949e',
    border: 'none',
    padding: '12px 24px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'not-allowed',
    marginTop: 'auto'
  },
  currentBadge: {
    background: '#238636',
    color: '#fff',
    padding: '4px 12px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: '600',
    display: 'inline-block',
    marginBottom: '16px'
  },
  message: {
    background: '#161b22',
    border: '1px solid #30363d',
    padding: '16px',
    borderRadius: '6px',
    marginBottom: '24px',
    color: '#58a6ff'
  },
  error: {
    background: '#3d1f1f',
    border: '1px solid #f85149',
    padding: '16px',
    borderRadius: '6px',
    marginBottom: '24px',
    color: '#f85149'
  }
}

export default function Billing() {
  const [plans, setPlans] = useState<PlansResponse['plans'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [upgrading, setUpgrading] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  // Check URL params for success/cancel
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('success') === 'true') {
      setMessage('Payment successful! Your plan has been upgraded.')
    } else if (params.get('canceled') === 'true') {
      setMessage('Payment was canceled. No changes made to your plan.')
    }
  }, [])

  useEffect(() => {
    fetch('/api/stripe/plans')
      .then(res => res.json())
      .then(data => {
        setPlans(data.plans)
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load plans')
        setLoading(false)
      })
  }, [])

  const handleUpgrade = async (plan: 'pro' | 'team') => {
    setUpgrading(plan)
    setError('')

    // Get agent ID from localStorage or generate one
    const agentId = localStorage.getItem('agentId') || `web-user-${Date.now()}`
    localStorage.setItem('agentId', agentId)

    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan,
          agentId,
          successUrl: `${window.location.origin}/app/billing?success=true`,
          cancelUrl: `${window.location.origin}/app/billing?canceled=true`
        })
      })

      const data = await res.json()

      if (res.ok && data.url) {
        window.location.href = data.url
      } else {
        setError(data.error || 'Failed to create checkout session')
        setUpgrading(null)
      }
    } catch {
      setError('Failed to connect to payment service')
      setUpgrading(null)
    }
  }

  if (loading) {
    return <div style={{ color: '#8b949e' }}>Loading plans...</div>
  }

  if (!plans) {
    return <div style={styles.error}>Failed to load pricing plans</div>
  }

  const formatPrice = (cents: number) => {
    if (cents === 0) return 'Free'
    return `$${(cents / 100).toFixed(0)}`
  }

  const formatLimit = (limit: number) => {
    return limit === -1 ? 'Unlimited' : limit.toString()
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Billing & Plans</h1>
      <p style={styles.subtitle}>Choose the plan that fits your needs</p>

      {message && <div style={styles.message}>{message}</div>}
      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.grid}>
        {/* Free Plan */}
        <div style={styles.card}>
          <span style={styles.currentBadge}>Current Plan</span>
          <h3 style={styles.planName}>{plans.free.name}</h3>
          <div>
            <span style={styles.price}>{formatPrice(plans.free.priceMonthly)}</span>
          </div>
          <ul style={styles.features}>
            <li style={styles.feature}>{formatLimit(plans.free.features.maxRepos)} repositories</li>
            <li style={styles.feature}>{formatLimit(plans.free.features.maxDeploymentsPerMonth)} deployments/month</li>
            <li style={styles.feature}>Community support</li>
          </ul>
          <button style={styles.buttonDisabled} disabled>Current Plan</button>
        </div>

        {/* Pro Plan */}
        <div style={styles.cardHighlight}>
          <h3 style={styles.planName}>{plans.pro.name}</h3>
          <div>
            <span style={styles.price}>{formatPrice(plans.pro.priceMonthly)}</span>
            <span style={styles.priceLabel}>/month</span>
          </div>
          <ul style={styles.features}>
            <li style={styles.feature}>{formatLimit(plans.pro.features.maxRepos)} repositories</li>
            <li style={styles.feature}>{formatLimit(plans.pro.features.maxDeploymentsPerMonth)} deployments</li>
            <li style={styles.feature}>Priority support</li>
            <li style={styles.feature}>Custom domains</li>
          </ul>
          <button
            style={upgrading === 'pro' ? styles.buttonDisabled : styles.button}
            onClick={() => handleUpgrade('pro')}
            disabled={upgrading !== null}
          >
            {upgrading === 'pro' ? 'Processing...' : 'Upgrade to Pro'}
          </button>
        </div>

        {/* Team Plan */}
        <div style={styles.card}>
          <h3 style={styles.planName}>{plans.team.name}</h3>
          <div>
            <span style={styles.price}>{formatPrice(plans.team.priceMonthly)}</span>
            <span style={styles.priceLabel}>/month</span>
          </div>
          <ul style={styles.features}>
            <li style={styles.feature}>Everything in Pro</li>
            <li style={styles.feature}>5 agent seats</li>
            <li style={styles.feature}>Team permissions</li>
            <li style={styles.feature}>Audit logs</li>
          </ul>
          <button
            style={upgrading === 'team' ? styles.buttonDisabled : styles.button}
            onClick={() => handleUpgrade('team')}
            disabled={upgrading !== null}
          >
            {upgrading === 'team' ? 'Processing...' : 'Upgrade to Team'}
          </button>
        </div>
      </div>
    </div>
  )
}
