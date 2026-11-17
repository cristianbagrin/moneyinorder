import { useEffect, useRef, useState } from 'preact/hooks'
import { cancelSignIn, recoverySaved, signIn, withAccountPassword, withOldPassword, withRecoveryKey, type Step } from '../lib/signin'
import { MIN_PASSWORD, validEmail } from '../lib/sync'
import { useSync } from './hooks'
import { toast } from './kit'
import { play } from './sound'
import './account.css'

/**
 * For every text field that is not the sign-in form (names of accounts, income sources...). iOS and the
 * password managers take a text field next to a password field, or with a name like "account", for a
 * login and offer to fill it: these attributes tell them all it is not one.
 */
export const NO_AUTOFILL = {
  autocomplete: 'off',
  spellcheck: false,
  autocorrect: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

export const ACCOUNT_PAGE = 'https://account.cristianbagrin.com'

type Ask = 'account-password' | 'old-password' | 'recovery'

/**
 * Sign in with the shared account (or create it), with the budget on this device. A real form with the fields
 * password managers know. Some sign-ins need one more answer (another password, the recovery key): the form
 * asks for it in place.
 */
export function AccountForm(props: { signInOnly?: boolean; email?: string; onDone?: () => void }) {
  const [mode, setMode] = useState<'in' | 'new'>('in')
  const [email, setEmail] = useState(props.email ?? '')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const creating = mode === 'new' && !props.signInOnly && !props.email

  const fail = (msg: string) => {
    play('error')
    toast(msg)
  }

  // A device with no budget yet has nothing to lose; otherwise ask before the account's budget replaces this one.
  const replace = () =>
    props.signInOnly || !!props.email ? true : confirm('Use the budget from your account on this device? What is on this device now is replaced')

  function after(step: Step) {
    if (step.kind === 'done') {
      setAsk(null)
      play('success')
      if (!step.recovery) toast(creating ? 'Account created. Your budget syncs now' : 'Signed in')
      props.onDone?.()
    } else if (step.kind === 'exists') fail('There’s already an account for this email. Sign in instead')
    else if (step.kind === 'fail') fail(step.message)
    else if (step.kind === 'cancelled') setAsk(null)
    else setAsk(step.kind)
  }

  async function submit(e: Event) {
    e.preventDefault()
    if (busy) return
    if (!validEmail(email)) return fail('That email doesn’t look right')
    if (creating && password.length < MIN_PASSWORD) return fail(`Use at least ${MIN_PASSWORD} characters for the password`)
    if (creating && repeat !== password) return fail('The passwords don’t match')
    setBusy(true)
    const step = await signIn(email, password, { create: creating, replace })
    setBusy(false)
    after(step)
  }

  if (ask) {
    return (
      <Followup
        ask={ask}
        onAnswer={async (answer) => {
          const step =
            ask === 'account-password' ? await withAccountPassword(answer!) : ask === 'old-password' ? await withOldPassword(answer) : await withRecoveryKey(answer!)
          after(step)
        }}
        onBack={() => {
          cancelSignIn()
          setAsk(null)
        }}
      />
    )
  }

  return (
    <form class="account" onSubmit={submit} noValidate>
      {!props.signInOnly && !props.email && (
        <div class="pills" role="group" aria-label="Sign in or create">
          <button type="button" class="pill sm" aria-pressed={mode === 'in'} onClick={() => setMode('in')}>
            Sign in
          </button>
          <button type="button" class="pill sm" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
            Create account
          </button>
        </div>
      )}
      <input
        type="email"
        name="email"
        autocomplete="username"
        aria-label="Email"
        placeholder="Email"
        spellcheck={false}
        autocapitalize="off"
        readOnly={!!props.email}
        value={email}
        onInput={(e) => setEmail(e.currentTarget.value)}
      />
      <input
        type="password"
        name="password"
        autocomplete={creating ? 'new-password' : 'current-password'}
        aria-label="Password"
        placeholder="Password"
        minLength={creating ? MIN_PASSWORD : undefined}
        value={password}
        onInput={(e) => setPassword(e.currentTarget.value)}
      />
      {creating && (
        <input
          type="password"
          name="password-repeat"
          autocomplete="new-password"
          aria-label="Repeat password"
          placeholder="Repeat password"
          value={repeat}
          onInput={(e) => setRepeat(e.currentTarget.value)}
        />
      )}
      <div class="account-go">
        <button type="submit" class={props.signInOnly ? 'btn block' : 'pill solid'} disabled={busy || !email.trim() || !password || (creating && !repeat)}>
          {busy ? (creating ? 'Creating…' : 'Signing in…') : creating ? 'Create account' : 'Sign in'}
        </button>
        {!creating && (
          <a class="account-link" href={`${ACCOUNT_PAGE}/#forgot`} target="_blank" rel="noopener">
            Forgot password?
          </a>
        )}
      </div>
      <p class="hint">The same account as Chinese Brain and At Peace</p>
    </form>
  )
}

const ASK: Record<Ask, { line: string; label: string; go: string }> = {
  'account-password': {
    line: 'This email already has an account with another password (from Chinese Brain or At Peace). Enter that password to bring your budget over.',
    label: 'Account password',
    go: 'Continue',
  },
  'old-password': {
    line: 'Enter your old Money in Order password to bring your synced budget over.',
    label: 'Old Money in Order password',
    go: 'Continue',
  },
  recovery: {
    line: 'Your password changed. Enter your recovery key to unlock your synced data.',
    label: 'Recovery key',
    go: 'Unlock',
  },
}

/** The one more thing a sign-in needs. */
function Followup(props: { ask: Ask; onAnswer: (answer: string | null) => Promise<void>; onBack: () => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [lost, setLost] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const a = ASK[props.ask]
  const key = props.ask === 'recovery'
  useEffect(() => field.current?.focus(), [props.ask])

  async function answer(v: string | null) {
    if (busy) return
    setBusy(true)
    await props.onAnswer(v)
    setBusy(false)
  }

  return (
    <form
      class="account"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) void answer(value)
      }}
    >
      <p class="account-ask">{a.line}</p>
      {key ? (
        <input
          ref={field}
          type="text"
          name="recovery-key"
          class="rk-field"
          autocapitalize="characters"
          aria-label={a.label}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
          {...NO_AUTOFILL}
        />
      ) : (
        <input
          ref={field}
          type="password"
          name="password"
          autocomplete="current-password"
          aria-label={a.label}
          placeholder={a.label}
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      )}
      <div class="account-go">
        <button type="submit" class="pill solid" disabled={busy || !value.trim()}>
          {busy ? (key ? 'Unlocking…' : 'Signing in…') : a.go}
        </button>
        <button type="button" class="pill sm" onClick={props.onBack} disabled={busy}>
          Back
        </button>
        {key && (
          <button type="button" class="account-link" aria-expanded={lost} onClick={() => setLost(!lost)}>
            Lost it?
          </button>
        )}
        {props.ask === 'old-password' && (
          <button
            type="button"
            class="account-link"
            disabled={busy}
            onClick={() => {
              if (confirm('Go on without your old synced budget? It stays on the server as it is, and this device’s budget is used instead')) void answer(null)
            }}
          >
            Forgot it?
          </button>
        )}
      </div>
      {key && lost && <p class="hint">Without the recovery key or a signed-in device, synced data can’t be opened. Your data on this device stays.</p>}
    </form>
  )
}

/** The recovery key just made, until the person says they saved it. Shown over everything. */
export function RecoveryKeyScreen() {
  const sync = useSync()
  const [saved, setSaved] = useState(false)
  const key = sync.pending
  useEffect(() => setSaved(false), [key])
  if (!key) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(key!)
      play('success')
      toast('Copied')
    } catch {
      toast('Couldn’t copy. Select the key and copy it')
    }
  }

  function download() {
    const text = [
      'Money in Order recovery key',
      '',
      key,
      '',
      `Account: ${sync.email ?? ''}`,
      `Made: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
      '',
      'If you forget your password, this key is the only way back into your synced data.',
      'Keep it somewhere safe, like a password manager.',
      '',
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = 'Money in Order recovery key.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div class="rk-layer" role="dialog" aria-modal="true" aria-labelledby="rk-title">
      <div class="rk">
        <h1 id="rk-title">Save your recovery key</h1>
        <p class="rk-line">If you forget your password, this key is the only way back into your synced data. Keep it somewhere safe, like a password manager.</p>
        <div class="rk-key" aria-label="Recovery key">
          {key.split('-').map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </div>
        <div class="rk-actions">
          <button class="pill" onClick={copy}>
            Copy
          </button>
          <button class="pill" onClick={download}>
            Download
          </button>
        </div>
        <p class="hint">Lose your password, this key and every signed-in device, and the synced data can’t be opened by anyone, us included.</p>
        <div class="rk-foot">
          <label class="rk-check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} />
            <span>I saved it</span>
          </label>
          <button
            class="btn block"
            disabled={!saved}
            onClick={async () => {
              await recoverySaved()
              play('success')
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
