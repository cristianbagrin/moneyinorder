import { ifNew, type Bucket } from './bucket'

// Which emails have an account, so one email can't end up with two budgets and a sign-in can say
// "wrong password" rather than "no account". The id is a hash of the email made on the device: this
// server never sees an email, a password or any data.

const noStore = { 'Cache-Control': 'no-store' }

export async function account(req: Request, id: string, bucket: Bucket): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(id)) return new Response('Bad id', { status: 400 })
  const key = `accounts/${id}`

  if (req.method === 'GET' || req.method === 'HEAD') {
    const meta = await bucket.head(key)
    return new Response(null, { status: meta ? 200 : 404, headers: noStore })
  }

  if (req.method === 'PUT') {
    const written = await bucket.put(key, '1', { onlyIf: ifNew() })
    return new Response(null, { status: written ? 201 : 409, headers: noStore })
  }

  return new Response('Method not allowed', { status: 405 })
}
