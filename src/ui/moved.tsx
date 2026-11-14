import { useSync } from './hooks'

/** Where the app lives now. Browser data doesn't follow a new address: the budget comes along by signing in there. */
export const NEW_HOME = 'https://moneyinorder.cristianbagrin.com'

/** True on the old Netlify address (and its previews), where the app no longer belongs. */
export function onOldAddress(host = location.hostname): boolean {
  return host === 'netlify.app' || host.endsWith('.netlify.app')
}

/** On the old address: says the app moved, and what this device still has to do before leaving. */
export function Moved() {
  const sync = useSync()
  if (!onOldAddress()) return null
  const step = !sync.email
    ? 'First sign in under Settings → Sync, so your budget comes along.'
    : sync.dirty || sync.state === 'syncing' || sync.state === 'error' || sync.state === 'offline'
      ? 'Wait until Settings → Sync says Synced, then move.'
      : 'Everything here is synced. Sign in there with the same email and password.'
  return (
    <div class="moved" role="status">
      <b>
        Money in Order moved to <a href={NEW_HOME}>{NEW_HOME.replace('https://', '')}</a>
      </b>
      <span>{step}</span>
    </div>
  )
}
