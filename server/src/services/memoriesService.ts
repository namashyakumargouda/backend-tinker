import { db, canAccessTrip } from '../db/database';
import { notifyTripMembers } from './notifications';
import { broadcast } from '../websocket';


type ServiceError = { success: false; error: { message: string; status: number } };
type ServiceResult<T> = { success: true; data: T } | ServiceError;

function fail(error: string, status: number): ServiceError {
  return { success: false, error: { message: error, status }};
}

function success<T>(data: T): ServiceResult<T> {
  return { success: true, data: data };
}

function mapDbError(error: unknown, fallbackMessage: string): ServiceError {
  if (error instanceof Error && /unique|constraint/i.test(error.message)) {
    return fail('Resource already exists', 409);
  }
  return fail(fallbackMessage, 500);
}

//-----------------------------------------------
//access check helper

export function canAccessUserPhoto(requestingUserId: number, ownerUserId: number, tripId: string, assetId: string, provider: string): boolean {
  if (requestingUserId === ownerUserId) {
    return true;
  }
  const sharedAsset = db.prepare(`
    SELECT 1
    FROM trip_photos
    WHERE user_id = ?
      AND asset_id = ?
      AND provider = ?
      AND trip_id = ?
      AND shared = 1
    LIMIT 1
    `).get(ownerUserId, assetId, provider, tripId);

  if (!sharedAsset) {
    return false;
  }
  return !!canAccessTrip(tripId, requestingUserId);
}

export function listTripPhotos(tripId: string, userId: number): ServiceResult<any[]> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    const photos = db.prepare(`
      SELECT tp.asset_id, tp.provider, tp.user_id, tp.shared, tp.added_at,
             u.username, u.avatar
      FROM trip_photos tp
      JOIN users u ON tp.user_id = u.id
      WHERE tp.trip_id = ?
        AND (tp.user_id = ? OR tp.shared = 1)
      ORDER BY tp.added_at ASC
    `).all(tripId, userId) as any[];

    return success(photos);
  } catch (error) {
    return mapDbError(error, 'Failed to list trip photos');
  }
}

export function listTripAlbumLinks(tripId: string, userId: number): ServiceResult<any[]> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    const links = db.prepare(`
      SELECT tal.id,
             tal.trip_id,
             tal.user_id,
             tal.provider,
             tal.album_id,
             tal.album_name,
             tal.sync_enabled,
             tal.last_synced_at,
             tal.created_at,
             u.username
      FROM trip_album_links tal
      JOIN users u ON tal.user_id = u.id
      WHERE tal.trip_id = ?
      ORDER BY tal.created_at ASC
    `).all(tripId);

    return success(links);
  } catch (error) {
    return mapDbError(error, 'Failed to list trip album links');
  }
}

//-----------------------------------------------
// managing photos in trip

function _addTripPhoto(tripId: string, userId: number, provider: string, assetId: string, shared: boolean): boolean {
  const result = db.prepare(
    'INSERT OR IGNORE INTO trip_photos (trip_id, user_id, asset_id, provider, shared) VALUES (?, ?, ?, ?, ?)'
  ).run(tripId, userId, assetId, provider, shared ? 1 : 0);
  return result.changes > 0;
}

export type Selection = {
  provider: string;
  asset_ids: string[];
};

export async function addTripPhotos(
  tripId: string,
  userId: number,
  shared: boolean,
  selections: Selection[],
  sid?: string,
): Promise<ServiceResult<{ added: number; shared: boolean }>> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  if (selections.length === 0) {
    return fail('No photos selected', 400);
  }

  try {
    let added = 0;
    for (const selection of selections) {
      for (const raw of selection.asset_ids) {
        const assetId = String(raw || '').trim();
        if (!assetId) continue;
        if (_addTripPhoto(tripId, userId, selection.provider, assetId, shared)) {
          added++;
        }
      }
    }

    await _notifySharedTripPhotos(tripId, userId, added);
    broadcast(tripId, 'memories:updated', { userId }, sid);
    return success({ added, shared });
  } catch (error) {
    return mapDbError(error, 'Failed to add trip photos');
  }
}


export async function setTripPhotoSharing(
  tripId: string,
  userId: number,
  provider: string,
  assetId: string,
  shared: boolean,
  sid?: string,
): Promise<ServiceResult<true>> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    db.prepare(`
      UPDATE trip_photos
      SET shared = ?
      WHERE trip_id = ?
        AND user_id = ?
        AND asset_id = ?
        AND provider = ?
    `).run(shared ? 1 : 0, tripId, userId, assetId, provider);

    await _notifySharedTripPhotos(tripId, userId, 1);
    broadcast(tripId, 'memories:updated', { userId }, sid);
    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to update photo sharing');
  }
}


export function removeTripPhoto(
  tripId: string,
  userId: number,
  provider: string,
  assetId: string,
  sid?: string,
): ServiceResult<true> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    db.prepare(`
      DELETE FROM trip_photos
      WHERE trip_id = ?
        AND user_id = ?
        AND asset_id = ?
        AND provider = ?
    `).run(tripId, userId, assetId, provider);
    
    broadcast(tripId, 'memories:updated', { userId }, sid);

    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to remove trip photo');
  }
}

// ----------------------------------------------
// managing album links in trip

export function createTripAlbumLink(tripId: string, userId: number, providerRaw: unknown, albumIdRaw: unknown, albumNameRaw: unknown): ServiceResult<true> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  const provider = String(providerRaw || '').toLowerCase();
  const albumId = String(albumIdRaw || '').trim();
  const albumName = String(albumNameRaw || '').trim();

  if (!provider) {
    return fail('provider is required', 400);
  }
  if (!albumId) {
    return fail('album_id required', 400);
  }

  try {
    const result = db.prepare(
      'INSERT OR IGNORE INTO trip_album_links (trip_id, user_id, provider, album_id, album_name) VALUES (?, ?, ?, ?, ?)'
    ).run(tripId, userId, provider, albumId, albumName);

    if (result.changes === 0) {
      return fail('Album already linked', 409);
    }

    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to link album');
  }
}

export function removeAlbumLink(tripId: string, linkId: string, userId: number): ServiceResult<true> {
  const access = canAccessTrip(tripId, userId);
  if (!access) {
    return fail('Trip not found or access denied', 404);
  }

  try {
    db.prepare('DELETE FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?')
      .run(linkId, tripId, userId);

    return success(true);
  } catch (error) {
    return mapDbError(error, 'Failed to remove album link');
  }
}

//helpers for album link syncing

export function getAlbumIdFromLink(tripId: string, linkId: string, userId: number): ServiceResult<string> {
  const access = canAccessTrip(tripId, userId);
  if (!access) return fail('Trip not found or access denied', 404);

  try {
    const row = db.prepare('SELECT album_id FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?')
      .get(linkId, tripId, userId) as { album_id: string } | null;

    return row ? success(row.album_id) : fail('Album link not found', 404);
  } catch {
    return fail('Failed to retrieve album link', 500);
  }
}

export function updateSyncTimeForAlbumLink(linkId: string): void {
  db.prepare('UPDATE trip_album_links SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(linkId);
}

//-----------------------------------------------
// notifications helper

async function _notifySharedTripPhotos(
  tripId: string,
  actorUserId: number,
  added: number,
): Promise<ServiceResult<void>> {
  if (added <= 0) return fail('No photos shared, skipping notifications', 200);

  try {
    const actorRow = db.prepare('SELECT username FROM users WHERE id = ?').get(actorUserId) as { username: string | null };

    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    await notifyTripMembers(Number(tripId), actorUserId, 'photos_shared', {
      trip: tripInfo?.title || 'Untitled',
      actor: actorRow?.username || 'Unknown',
      count: String(added),
    });
    return success(undefined);
  } catch {
    return fail('Failed to send notifications', 500);
  }
}


