/**
 * Unit tests for MCP place tools: create_place, update_place, delete_place, list_categories, search_place.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
      if (!place) return null;
      const tags = db.prepare(`SELECT t.* FROM tags t JOIN place_tags pt ON t.id = pt.tag_id WHERE pt.place_id = ?`).all(placeId);
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags };
    },
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcast: broadcastMock }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip, createPlace } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  testDb.close();
});

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// create_place
// ---------------------------------------------------------------------------

describe('Tool: create_place', () => {
  it('creates a place with all fields', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const cat = testDb.prepare('SELECT id FROM categories LIMIT 1').get() as { id: number };

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_place',
        arguments: {
          tripId: trip.id,
          name: 'Eiffel Tower',
          lat: 48.8584,
          lng: 2.2945,
          address: 'Champ de Mars, Paris',
          category_id: cat.id,
          notes: 'Must visit',
          website: 'https://toureiffel.paris',
          phone: '+33 892 70 12 39',
        },
      });
      const data = parseToolResult(result) as any;
      expect(data.place.name).toBe('Eiffel Tower');
      expect(data.place.lat).toBeCloseTo(48.8584);
      expect(data.place.category_id).toBe(cat.id);
    });
  });

  it('creates a place with minimal fields', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_place',
        arguments: { tripId: trip.id, name: 'Mystery Spot' },
      });
      const data = parseToolResult(result) as any;
      expect(data.place.name).toBe('Mystery Spot');
      expect(data.place.trip_id).toBe(trip.id);
    });
  });

  it('broadcasts place:created event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'create_place', arguments: { tripId: trip.id, name: 'Cafe' } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'place:created', expect.any(Object));
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_place', arguments: { tripId: trip.id, name: 'Hack' } });
      expect(result.isError).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_place', arguments: { tripId: trip.id, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_place
// ---------------------------------------------------------------------------

describe('Tool: update_place', () => {
  it('updates specific fields and preserves others', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id, { name: 'Old Name' });

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_place',
        arguments: { tripId: trip.id, placeId: place.id, name: 'New Name' },
      });
      const data = parseToolResult(result) as any;
      expect(data.place.name).toBe('New Name');
      // lat/lng preserved from original
      expect(data.place.lat).toBeCloseTo(place.lat ?? 48.8566);
    });
  });

  it('broadcasts place:updated event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'update_place', arguments: { tripId: trip.id, placeId: place.id, name: 'Updated' } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'place:updated', expect.any(Object));
    });
  });

  it('returns error for place not found in trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_place', arguments: { tripId: trip.id, placeId: 99999 } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const place = createPlace(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_place', arguments: { tripId: trip.id, placeId: place.id, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_place
// ---------------------------------------------------------------------------

describe('Tool: delete_place', () => {
  it('deletes an existing place', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_place', arguments: { tripId: trip.id, placeId: place.id } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(testDb.prepare('SELECT id FROM places WHERE id = ?').get(place.id)).toBeUndefined();
    });
  });

  it('broadcasts place:deleted event', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'delete_place', arguments: { tripId: trip.id, placeId: place.id } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'place:deleted', expect.any(Object));
    });
  });

  it('returns error for place not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_place', arguments: { tripId: trip.id, placeId: 99999 } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const place = createPlace(testDb, trip.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_place', arguments: { tripId: trip.id, placeId: place.id } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// list_categories
// ---------------------------------------------------------------------------

describe('Tool: list_categories', () => {
  it('returns all categories with id, name, color, icon', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_categories', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.categories).toBeDefined();
      expect(data.categories.length).toBeGreaterThan(0);
      const cat = data.categories[0];
      expect(cat).toHaveProperty('id');
      expect(cat).toHaveProperty('name');
      expect(cat).toHaveProperty('color');
      expect(cat).toHaveProperty('icon');
    });
  });
});

// ---------------------------------------------------------------------------
// search_place
// ---------------------------------------------------------------------------

describe('Tool: search_place', () => {
  it('returns formatted results from Nominatim', async () => {
    const { user } = createUser(testDb);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          osm_type: 'node',
          osm_id: 12345,
          name: 'Eiffel Tower',
          display_name: 'Eiffel Tower, Paris, France',
          lat: '48.8584',
          lon: '2.2945',
        },
      ],
    });
    vi.stubGlobal('fetch', mockFetch);

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'search_place', arguments: { query: 'Eiffel Tower' } });
      const data = parseToolResult(result) as any;
      expect(data.places).toHaveLength(1);
      expect(data.places[0].name).toBe('Eiffel Tower');
      expect(data.places[0].osm_id).toBe('node:12345');
      expect(data.places[0].lat).toBeCloseTo(48.8584);
    });

    vi.unstubAllGlobals();
  });

  it('returns error when Nominatim API fails', async () => {
    const { user } = createUser(testDb);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'search_place', arguments: { query: 'something' } });
      expect(result.isError).toBe(true);
    });

    vi.unstubAllGlobals();
  });
});
