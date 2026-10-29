import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLoopbackPersonalClient, type PersonalTurnMessage } from './tarx-personal-turn.ts'
import { ownerNamespace } from './tarx-local-learning.ts'
import { deliverOwnedPersonalContext } from './tarx-context-consumer.ts'
import { createContextCache, measureQuoted, restrictClassification, type ContextScope, type PackRequest } from './tarx-context-cache.ts'

const LOCAL_BODY = 'LOCAL_ONLY_BODY_zz'
const EXPORT_BODY = 'EXPORT_BODY_zz'
const OTHER_OWNER_BODY = 'OTHER_OWNER_BODY_zz'
const OTHER_CHANNEL_BODY = 'OTHER_CHANNEL_BODY_zz'
const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)

function scope(owner: string, patch: Partial<ContextScope> = {}): ContextScope {
  return {
    owner_namespace: owner,
    workspace_id: 'workspace-a',
    channel_id: 'channel-a',
    purpose: 'continue-task',
    grant_revision: 'grant-1',
    ...patch,
  }
}

function fact(owner: string, factId: string, body: string, classification: 'private_local' | 'export_eligible', patch: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    fact_id: factId,
    scope: scope(owner),
    kind: 'goal',
    revision: 1,
    source_version: 'source-1',
    classification,
    body,
    expires_at: '2026-10-29T00:00:00.000Z',
    deleted_at: null,
    ...patch,
  }
}

function request(owner: string, factIds: string[], patch: Record<string, unknown> = {}): PackRequest {
  return {
    schema_version: 1,
    scope: scope(owner),
    recipient: { location: 'this_computer', provider_id: 'local-provider', model_id: 'model-local-a' },
    policy_version: 'policy-1',
    prompt_version: 'prompt-1',
    fact_ids: factIds,
    max_bytes: 4096,
    ...patch,
  } as PackRequest
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-context-cache-'))
  const file = join(dir, 'cache.json')
  const owner = ownerNamespace('subject-a', 'install-a')
  const other = ownerNamespace('subject-b', 'install-b')
  const cache = createContextCache({ file, key: KEY, now: () => NOW })
  return { dir, file, owner, other, cache }
}

test('schema shape stays the server contract', async () => {
  const schema = JSON.parse(await readFile(new URL('./context-cache.v1.schema.json', import.meta.url), 'utf8')) as { $id: string; $defs: { fact: { required: string[] }; pack_request: { properties: { max_bytes: { maximum: number } } } } }
  assert.equal(schema.$id, 'urn:tarx:context-cache:1')
  assert.equal(schema.$defs.fact.required.includes('classification'), true)
  assert.equal(schema.$defs.pack_request.properties.max_bytes.maximum, 32768)
  assert.equal(restrictClassification('export_eligible', ['private_local']), 'private_local')
})

test('packs miss across owner, channel, purpose, and provider and stay encrypted', async () => {
  const fx = await fixture()
  try {
    assert.equal((await fx.cache.putFact(fx.owner, fact(fx.owner, 'local-fact', LOCAL_BODY, 'private_local'))).ok, true)
    assert.equal((await fx.cache.putFact(fx.owner, fact(fx.owner, 'export-fact', EXPORT_BODY, 'export_eligible'))).ok, true)
    assert.equal((await fx.cache.putFact(fx.other, fact(fx.other, 'other-fact', OTHER_OWNER_BODY, 'export_eligible'))).ok, true)
    assert.equal((await fx.cache.putFact(fx.owner, fact(fx.owner, 'channel-fact', OTHER_CHANNEL_BODY, 'export_eligible', { scope: scope(fx.owner, { channel_id: 'channel-b' }) }))).ok, true)
    const stored = await readFile(fx.file, 'utf8')
    for (const secret of [LOCAL_BODY, EXPORT_BODY, OTHER_OWNER_BODY, OTHER_CHANNEL_BODY]) assert.equal(stored.includes(secret), false)

    const local = await fx.cache.pack(fx.owner, request(fx.owner, ['export-fact', 'local-fact', 'other-fact', 'channel-fact']))
    assert.equal(local.ok, true)
    if (!local.ok) return
    assert.equal(local.cache, 'rebuilt')
    assert.deepEqual(local.packet.facts.map((item) => item.fact_id), ['export-fact', 'local-fact'])
    assert.equal(JSON.stringify(local.packet).includes(OTHER_OWNER_BODY), false)
    assert.equal(JSON.stringify(local.packet).includes(OTHER_CHANNEL_BODY), false)
    assert.equal(local.packet.omitted_count, 2)
    assert.equal(local.packet.complete, false)
    const measured = measureQuoted(local.packet.facts)
    assert.equal(local.packet.serialized_bytes, measured.serialized_bytes)
    assert.equal(local.packet.token_estimate, measured.token_estimate)
    assert.equal(local.cache_key.includes(LOCAL_BODY), false)

    const channel = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact'], { scope: scope(fx.owner, { channel_id: 'channel-b' }) }))
    assert.equal(channel.ok, true)
    if (channel.ok) assert.equal(JSON.stringify(channel.packet).includes(LOCAL_BODY), false)
    const purpose = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact'], { scope: scope(fx.owner, { purpose: 'other-purpose' }) }))
    assert.equal(purpose.ok, true)
    if (purpose.ok) assert.equal(JSON.stringify(purpose.packet).includes(LOCAL_BODY), false)
    const provider = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact'], { recipient: { location: 'this_computer', provider_id: 'other-provider', model_id: 'model-local-a' } }))
    assert.equal(provider.ok, true)
    if (provider.ok) {
      assert.equal(provider.cache, 'rebuilt')
      assert.notEqual(provider.cache_key, local.cache_key)
    }
    const ownerMiss = await fx.cache.pack(fx.other, request(fx.owner, ['local-fact']))
    assert.deepEqual(ownerMiss, { ok: false, error: 'owner_mismatch' })
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
})

test('warm remote cache is revoked and local facts never cross', async () => {
  const fx = await fixture()
  try {
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'local-fact', LOCAL_BODY, 'private_local'))
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'export-fact', EXPORT_BODY, 'export_eligible'))
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'summary-fact', 'SUMMARY_BODY_zz', 'export_eligible', { kind: 'summary' }), ['private_local'])
    const remote = { location: 'supercomputer' as const, provider_id: 'remote-provider', model_id: 'model-remote-b' }
    const denied = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact', 'export-fact', 'summary-fact'], { recipient: remote }))
    assert.deepEqual(denied, { ok: false, error: 'export_grant_required' })
    assert.equal(JSON.stringify(denied).includes(LOCAL_BODY), false)
    assert.equal(JSON.stringify(denied).includes(EXPORT_BODY), false)
    assert.equal(JSON.stringify(denied).includes('SUMMARY_BODY_zz'), false)
    const grant = { ...scope(fx.owner), provider_id: remote.provider_id, model_id: remote.model_id }
    assert.equal((await fx.cache.putGrant(fx.owner, grant)).ok, true)
    const first = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact', 'export-fact', 'summary-fact'], { recipient: remote }))
    const second = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact', 'export-fact', 'summary-fact'], { recipient: remote }))
    assert.equal(first.ok && second.ok && second.cache === 'hit', true)
    if (first.ok) {
      assert.deepEqual(first.packet.facts.map((item) => item.body), [EXPORT_BODY])
      assert.equal(JSON.stringify(first.packet).includes(LOCAL_BODY), false)
      assert.equal(JSON.stringify(first.packet).includes('SUMMARY_BODY_zz'), false)
      assert.equal(first.packet.omitted_count, 2)
      assert.equal(first.packet.complete, false)
    }
    assert.equal((await fx.cache.revokeGrant(fx.owner, grant, '2026-10-28T12:05:00.000Z')).ok, true)
    const revoked = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact', 'export-fact', 'summary-fact'], { recipient: remote }))
    assert.deepEqual(revoked, { ok: false, error: 'export_grant_required' })
    assert.equal(JSON.stringify(revoked).includes(EXPORT_BODY), false)
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
})

test('expiry, delete, and source revision invalidate a warm pack', async () => {
  const fx = await fixture()
  try {
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'local-fact', LOCAL_BODY, 'private_local'))
    const first = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact']))
    assert.equal(first.ok && first.cache, 'rebuilt')
    const expired = createContextCache({ file: fx.file, key: KEY, now: () => Date.parse('2026-10-30T00:00:00.000Z') })
    const afterExpiry = await expired.pack(fx.owner, request(fx.owner, ['local-fact']))
    assert.equal(afterExpiry.ok, true)
    if (afterExpiry.ok) {
      assert.equal(afterExpiry.packet.facts.length, 0)
      assert.equal(afterExpiry.packet.omitted_count, 1)
      assert.equal(JSON.stringify(afterExpiry.packet).includes(LOCAL_BODY), false)
    }
    const restored = createContextCache({ file: fx.file, key: KEY, now: () => NOW })
    await restored.putFact(fx.owner, fact(fx.owner, 'local-fact', LOCAL_BODY, 'private_local', { expires_at: '2026-10-29T00:00:00.000Z' }))
    assert.equal((await restored.deleteFact(fx.owner, 'local-fact', '2026-10-28T12:10:00.000Z')).ok, true)
    const deleted = await restored.pack(fx.owner, request(fx.owner, ['local-fact']))
    assert.equal(deleted.ok && deleted.packet.facts.length === 0, true)
    const revisedBody = `REVISED_BODY_zz${'x'.repeat(240)}`
    const revisedQuote = measureQuoted([{ fact_id: 'local-fact', kind: 'goal', revision: 2, source_version: 'source-2', body: revisedBody }])
    assert.equal(revisedQuote.serialized_bytes > 256 && revisedQuote.serialized_bytes <= 2048, true)
    await restored.putFact(fx.owner, fact(fx.owner, 'local-fact', revisedBody, 'private_local', { revision: 2, source_version: 'source-2', deleted_at: null }))
    const revised = await restored.pack(fx.owner, request(fx.owner, ['local-fact']))
    assert.equal(revised.ok, true)
    if (first.ok && revised.ok) {
      assert.notEqual(revised.cache_key, first.cache_key)
      assert.equal(JSON.stringify(revised.packet).includes(LOCAL_BODY), false)
      assert.equal(revised.packet.facts[0]?.body, revisedBody)
      assert.equal(revised.packet.serialized_bytes, revisedQuote.serialized_bytes)
      assert.equal(revised.packet.token_estimate, revisedQuote.token_estimate)
    }
    const prompt = await restored.pack(fx.owner, request(fx.owner, ['local-fact'], { prompt_version: 'prompt-2' }))
    const budget = await restored.pack(fx.owner, request(fx.owner, ['local-fact'], { max_bytes: 2048 }))
    const model = await restored.pack(fx.owner, request(fx.owner, ['local-fact'], { recipient: { location: 'this_computer', provider_id: 'local-provider', model_id: 'model-local-b' } }))
    assert.equal(prompt.ok && budget.ok && model.ok, true)
    if (revised.ok && prompt.ok && budget.ok && model.ok) {
      assert.equal(prompt.cache, 'rebuilt')
      assert.notEqual(prompt.cache_key, revised.cache_key)
      assert.notEqual(budget.cache_key, revised.cache_key)
      assert.notEqual(model.cache_key, revised.cache_key)
    }
    const tight = await restored.pack(fx.owner, request(fx.owner, ['local-fact'], { max_bytes: 256 }))
    assert.equal(tight.ok, true)
    if (tight.ok) {
      assert.equal(tight.packet.facts.length, 0)
      assert.equal(tight.packet.omitted_count, 1)
      assert.equal(tight.packet.serialized_bytes, measureQuoted([]).serialized_bytes)
      assert.equal(tight.packet.token_estimate, 1)
    }
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
})

test('restart reads the same key and the wrong key fails closed', async () => {
  const fx = await fixture()
  try {
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'local-fact', LOCAL_BODY, 'private_local'))
    await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact']))
    const restarted = createContextCache({ file: fx.file, key: KEY, now: () => NOW })
    const hit = await restarted.pack(fx.owner, request(fx.owner, ['local-fact']))
    assert.equal(hit.ok && hit.cache === 'hit' && hit.packet.facts[0]?.body === LOCAL_BODY, true)
    const wrong = createContextCache({ file: fx.file, key: OTHER_KEY, now: () => NOW })
    const rejected = await wrong.pack(fx.owner, request(fx.owner, ['local-fact']))
    assert.deepEqual(rejected, { ok: false, error: 'context_key_rejected' })
    assert.equal(JSON.stringify(rejected).includes(LOCAL_BODY), false)
    const still = await restarted.pack(fx.owner, request(fx.owner, ['local-fact']))
    assert.equal(still.ok && still.packet.facts[0]?.body === LOCAL_BODY, true)
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
})

test('the loopback personal client receives only authorized quoted data', async () => {
  const fx = await fixture()
  try {
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'local-fact', LOCAL_BODY, 'private_local'))
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'export-fact', EXPORT_BODY, 'export_eligible'))
    await fx.cache.putFact(fx.owner, fact(fx.owner, 'summary-fact', 'SUMMARY_BODY_zz', 'export_eligible', { kind: 'summary' }), ['private_local'])
    const messages: PersonalTurnMessage[] = [{ role: 'user', content: 'Continue the task.' }]
    const seen: { url: string; body: string }[] = []
    const clientFor = (model: string) => createLoopbackPersonalClient({
      baseURL: 'http://127.0.0.1:9/v1',
      model,
      fetcher: async (url, init) => {
        seen.push({ url: String(url), body: String(init?.body) })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const localA = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact', 'export-fact', 'summary-fact']))
    const localB = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact', 'export-fact', 'summary-fact'], { recipient: { location: 'this_computer', provider_id: 'local-provider', model_id: 'model-local-b' } }))
    assert.equal(localA.ok && localB.ok, true)
    if (!localA.ok || !localB.ok) return
    assert.notEqual(localA.cache_key, localB.cache_key)
    const before = seen.length
    const sentA = await deliverOwnedPersonalContext({ client: clientFor('model-local-a'), messages, resolution: localA })
    const sentB = await deliverOwnedPersonalContext({ client: clientFor('model-local-b'), messages, resolution: localB })
    assert.equal(sentA.ok && sentB.ok && sentA.sent && sentB.sent, true)
    assert.equal(seen.length, before + 2)
    assert.equal(seen[0]?.url, 'http://127.0.0.1:9/v1/chat/completions')
    const payloads = seen.map((item) => JSON.parse(item.body) as { model: string; messages: { role: string; content: string }[] })
    assert.deepEqual(payloads.map((item) => item.model), ['model-local-a', 'model-local-b'])
    for (const payload of payloads) {
      assert.equal(payload.messages.some((item) => item.role === 'system'), false)
      assert.equal(payload.messages.some((item) => item.content.includes(LOCAL_BODY)), true)
      assert.equal(payload.messages.some((item) => item.content.includes(EXPORT_BODY)), true)
      assert.equal(payload.messages.some((item) => item.content.includes('SUMMARY_BODY_zz')), true)
      assert.equal(JSON.stringify(payload).includes(OTHER_OWNER_BODY), false)
      assert.equal(payload.messages.at(-1)?.content, 'Continue the task.')
    }
    const remote = await fx.cache.pack(fx.owner, request(fx.owner, ['local-fact', 'export-fact', 'summary-fact'], { recipient: { location: 'supercomputer', provider_id: 'remote-provider', model_id: 'model-remote-b' } }))
    const calls = seen.length
    const blocked = await deliverOwnedPersonalContext({ client: clientFor('model-remote-b'), messages, resolution: remote })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.sent, false)
    assert.equal(seen.length, calls)
    assert.equal(JSON.stringify(blocked).includes(LOCAL_BODY), false)
    if (localA.ok) {
      const forged = await deliverOwnedPersonalContext({
        client: clientFor('model-local-a'),
        messages,
        resolution: { ...localA, packet: { ...localA.packet, recipient: { location: 'supercomputer', provider_id: 'remote-provider', model_id: 'model-remote-b' } } },
      })
      assert.equal(forged.sent, false)
      assert.equal(forged.ok, false)
      assert.equal(seen.length, calls)
    }
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
})

test('review: differing omitted fact requests cannot reuse a complete cached packet', async () => {
 const fx=await fixture()
 try {
  await fx.cache.putFact(fx.owner,fact(fx.owner,'local-fact',LOCAL_BODY,'private_local'))
  const first=await fx.cache.pack(fx.owner,request(fx.owner,['local-fact']))
  const second=await fx.cache.pack(fx.owner,request(fx.owner,['local-fact','missing-fact']))
  assert.ok(first.ok && second.ok)
  if(first.ok && second.ok){assert.notEqual(first.cache_key,second.cache_key);assert.equal(first.packet.complete,true);assert.equal(second.packet.complete,false);assert.equal(second.packet.omitted_count,1)}
 } finally {await rm(fx.dir,{recursive:true,force:true})}
})
test('review: contextual consumer preserves the existing response sanitization boundary', async () => {
 const fx=await fixture()
 try {
  const resolution=await fx.cache.pack(fx.owner,request(fx.owner,[]))
  const result=await deliverOwnedPersonalContext({client:async()=> '\u0000'+'x'.repeat(9000),messages:[{role:'user',content:'hello'}],resolution})
  assert.ok(result.ok)
  if(result.ok){assert.equal(result.content.includes('\u0000'),false);assert.equal(result.content.length,8000)}
 } finally {await rm(fx.dir,{recursive:true,force:true})}
})
