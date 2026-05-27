import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatcher.js';
import { getDb } from '../src/db.js';
import { registry } from '../src/providers/registry.js';
import { FakeProvider } from './helpers/fake-provider.js';
import { rateLimiter } from '../src/rate-limiter.js';
import { UpstreamHttpError } from '../src/errors.js';
import type { InboxData, ProviderDomainMode } from '../src/providers/base.js';

class SlowFakeProvider extends FakeProvider {
  constructor(opts: ConstructorParameters<typeof FakeProvider>[0] & { delayMs: number }) {
    super(opts);
    this.delayMs = opts.delayMs;
  }

  private readonly delayMs: number;

  override async createInbox(opts?: { domain?: string; username?: string }): Promise<InboxData> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.createInbox(opts);
  }
}

class DomainlessFakeProvider extends FakeProvider {
  getDomainsCount = 0;

  override getDomainMode(): ProviderDomainMode {
    return 'from_create';
  }

  override async getDomains(): Promise<string[]> {
    this.getDomainsCount++;
    throw new Error('getDomains should not be called for from_create providers');
  }
}

class RateLimitedFakeProvider extends FakeProvider {
  constructor(opts: ConstructorParameters<typeof FakeProvider>[0] & { retryAfter?: string }) {
    super(opts);
    this.retryAfter = opts.retryAfter;
  }

  private readonly retryAfter?: string;

  override async createInbox(): Promise<InboxData> {
    this.createCount++;
    throw new UpstreamHttpError(`[${this.meta.name}] Create failed: 429`, 429, this.retryAfter);
  }
}

class TransientFailingFakeProvider extends FakeProvider {
  override async createInbox(): Promise<InboxData> {
    this.createCount++;
    throw new UpstreamHttpError(`[${this.meta.name}] Create failed: 503`, 503);
  }
}

describe('dispatcher provider selection', () => {
  it('honors explicit provider create rate limits', async () => {
    const provider = new FakeProvider();
    registry.register(provider);

    await expect(dispatch({ provider: 'fake' })).resolves.toMatchObject({
      address: 'user1@example.test',
      provider: 'fake',
    });
    await expect(dispatch({ provider: 'fake' })).rejects.toThrow(/rate-limited/);
    expect(provider.createCount).toBe(1);

    registry.unregister('fake');
  });

  it('does not dispatch to disabled explicit providers', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    getDb().prepare(`UPDATE provider_config SET enabled = 0 WHERE provider = ?`).run('fake');

    await expect(dispatch({ provider: 'fake' })).rejects.toThrow(/disabled/);
    expect(provider.createCount).toBe(0);

    registry.unregister('fake');
  });

  it('does not fallback to disabled paired providers', async () => {
    const mailtm = new FakeProvider({ name: 'mailtm', displayName: 'Mail.tm' });
    const mailgw = new FakeProvider({ name: 'mailgw', displayName: 'Mail.gw' });
    registry.register(mailtm);
    registry.register(mailgw);
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    db.prepare(`UPDATE provider_config SET enabled = 1 WHERE provider = 'mailtm'`).run();
    rateLimiter.recordCreate('mailtm');

    await expect(dispatch({})).rejects.toThrow(/rate-limited|exhausted/i);
    expect(mailgw.createCount).toBe(0);

    registry.unregister('mailtm');
    registry.unregister('mailgw');
  });

  it('applies service block rules to explicit providers', async () => {
    const provider = new FakeProvider();
    registry.register(provider);
    getDb().prepare(
      `INSERT INTO blocks (service, domain, provider) VALUES (?, ?, ?)`,
    ).run('svc', 'example.test', 'fake');

    await expect(dispatch({ provider: 'fake', for: 'svc', domain: 'example.test' }))
      .rejects.toThrow(/blocked/);
    expect(provider.createCount).toBe(0);

    registry.unregister('fake');
  });

  it('rotates domains when an explicit provider has multiple available domains', async () => {
    const provider = new FakeProvider({
      domains: ['a.test', 'b.test', 'c.test'],
      rateLimit: { createPerMinute: 0, pollPerMinute: 2 },
    });
    registry.register(provider);

    await dispatch({ provider: 'fake' });
    await dispatch({ provider: 'fake' });
    await dispatch({ provider: 'fake' });

    expect(new Set(provider.createdDomains)).toEqual(new Set(['a.test', 'b.test', 'c.test']));

    registry.unregister('fake');
  });

  it('rotates only across unblocked domains', async () => {
    const provider = new FakeProvider({
      domains: ['a.test', 'b.test', 'c.test'],
      rateLimit: { createPerMinute: 0, pollPerMinute: 2 },
    });
    registry.register(provider);
    getDb().prepare(
      `INSERT INTO blocks (service, domain, provider) VALUES (?, ?, ?)`,
    ).run('svc', 'b.test', 'fake');

    await dispatch({ provider: 'fake', for: 'svc' });
    await dispatch({ provider: 'fake', for: 'svc' });
    await dispatch({ provider: 'fake', for: 'svc' });
    await dispatch({ provider: 'fake', for: 'svc' });

    expect(provider.createdDomains).not.toContain('b.test');
    expect(new Set(provider.createdDomains)).toEqual(new Set(['a.test', 'c.test']));

    registry.unregister('fake');
  });

  it('reserves create capacity before upstream calls during auto-dispatch', async () => {
    const primary = new SlowFakeProvider({
      name: 'primary',
      displayName: 'Primary',
      trustLevel: 5,
      rateLimit: { createPerMinute: 1, pollPerMinute: 2 },
      delayMs: 25,
    });
    const fallback = new FakeProvider({
      name: 'fallback',
      displayName: 'Fallback',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(primary);
    registry.register(fallback);

    const results = await Promise.all([dispatch({}), dispatch({})]);

    expect(results.map((r) => r.provider).sort()).toEqual(['fallback', 'primary']);
    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(1);

    registry.unregister('primary');
    registry.unregister('fallback');
  });

  it('does not call getDomains while auto-dispatching from_create providers', async () => {
    const provider = new DomainlessFakeProvider({
      name: 'domainless',
      displayName: 'Domainless',
      rateLimit: { createPerMinute: 1, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(provider);

    await expect(dispatch({})).resolves.toMatchObject({
      provider: 'domainless',
    });
    expect(provider.getDomainsCount).toBe(0);
    expect(provider.createCount).toBe(1);

    registry.unregister('domainless');
  });

  it('falls back and cools down a provider that returns upstream 429', async () => {
    const primary = new RateLimitedFakeProvider({
      name: 'primary-429',
      displayName: 'Primary 429',
      trustLevel: 5,
      retryAfter: '120',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const fallback = new FakeProvider({
      name: 'fallback-429',
      displayName: 'Fallback 429',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(primary);
    registry.register(fallback);

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'fallback-429' });
    const status = rateLimiter.getCreateStatus('primary-429');

    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(1);
    expect(status.available).toBe(false);
    expect(status.cooldownReason).toBe('rate-limit');
    expect(status.nextAvailableAt).not.toBeNull();
    expect(Date.parse(status.nextAvailableAt!) - Date.now()).toBeGreaterThan(100_000);

    registry.unregister('primary-429');
    registry.unregister('fallback-429');
  });

  it('uses exponential default cooldown when upstream 429 has no Retry-After', async () => {
    const provider = new RateLimitedFakeProvider({
      name: 'no-retry-after',
      displayName: 'No Retry After',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    registry.register(provider);

    rateLimiter.recordRateLimitFailure('no-retry-after');
    const first = rateLimiter.getCreateStatus('no-retry-after').nextAvailableAt!;
    rateLimiter.recordRateLimitFailure('no-retry-after');
    const second = rateLimiter.getCreateStatus('no-retry-after').nextAvailableAt!;

    expect(Date.parse(first) - Date.now()).toBeGreaterThan(50_000);
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first) + 50_000);

    registry.unregister('no-retry-after');
  });

  it('does not fall back when an explicit provider returns upstream 429', async () => {
    const primary = new RateLimitedFakeProvider({
      name: 'explicit-429',
      displayName: 'Explicit 429',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const fallback = new FakeProvider({
      name: 'explicit-fallback',
      displayName: 'Explicit Fallback',
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    registry.register(primary);
    registry.register(fallback);

    await expect(dispatch({ provider: 'explicit-429' })).rejects.toMatchObject({ status: 429 });
    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(0);

    registry.unregister('explicit-429');
    registry.unregister('explicit-fallback');
  });

  it('falls back and briefly cools down a provider that returns upstream 5xx', async () => {
    const primary = new TransientFailingFakeProvider({
      name: 'primary-503',
      displayName: 'Primary 503',
      trustLevel: 5,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const fallback = new FakeProvider({
      name: 'fallback-503',
      displayName: 'Fallback 503',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 2 },
    });
    const db = getDb();
    db.prepare(`UPDATE provider_config SET enabled = 0`).run();
    registry.register(primary);
    registry.register(fallback);

    await expect(dispatch({})).resolves.toMatchObject({ provider: 'fallback-503' });
    const status = rateLimiter.getCreateStatus('primary-503');

    expect(primary.createCount).toBe(1);
    expect(fallback.createCount).toBe(1);
    expect(status.available).toBe(false);
    expect(status.cooldownReason).toBe('transient-error');
    expect(status.nextAvailableAt).not.toBeNull();
    expect(Date.parse(status.nextAvailableAt!) - Date.now()).toBeGreaterThan(20_000);
    expect(Date.parse(status.nextAvailableAt!) - Date.now()).toBeLessThanOrEqual(30_000);

    registry.unregister('primary-503');
    registry.unregister('fallback-503');
  });
});
