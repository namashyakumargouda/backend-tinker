import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Response as ExpressResponse } from 'express';
import { db } from '../db/database';
import { decrypt_api_key, maybe_encrypt_api_key } from './apiKeyCrypto';
import { checkSsrf } from '../utils/ssrfGuard';
import { addTripPhotos, getAlbumIdFromLink, Selection, updateSyncTimeForAlbumLink } from './memoriesService';
import { error } from 'node:console';
import { th } from 'zod/locales';

const SYNOLOGY_API_TIMEOUT_MS = 30000;
const SYNOLOGY_PROVIDER = 'synologyphotos';
const SYNOLOGY_ENDPOINT_PATH = '/photo/webapi/entry.cgi';
const SYNOLOGY_DEFAULT_THUMBNAIL_SIZE = 'sm';

interface SynologyCredentials {
    synology_url: string;
    synology_username: string;
    synology_password: string;
}

interface SynologySession {
    success: boolean;
    sid?: string;
    error?: { code: number; message?: string };
}

interface ApiCallParams {
    api: string;
    method: string;
    version?: number;
    [key: string]: unknown;
}

interface SynologyApiResponse<T> {
    success: boolean;
    data?: T;
    error?: { code: number; message?: string };
}

export class SynologyServiceError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export interface SynologySettings {
    synology_url: string;
    synology_username: string;
    connected: boolean;
}

export interface SynologyConnectionResult {
    connected: boolean;
    user?: { username: string };
    error?: string;
}

export interface SynologyAlbumLinkInput {
    album_id?: string | number;
    album_name?: string;
}

export interface SynologySearchInput {
    from?: string;
    to?: string;
    offset?: number;
    limit?: number;
}

export interface SynologyProxyResult {
    status: number;
    headers: Record<string, string | null>;
    body: ReadableStream<Uint8Array> | null;
}

interface SynologyPhotoInfo {
    id: string;
    takenAt: string | null;
    city: string | null;
    country: string | null;
    state?: string | null;
    camera?: string | null;
    lens?: string | null;
    focalLength?: string | number | null;
    aperture?: string | number | null;
    shutter?: string | number | null;
    iso?: string | number | null;
    lat?: number | null;
    lng?: number | null;
    orientation?: number | null;
    description?: string | null;
    filename?: string | null;
    filesize?: number | null;
    width?: number | null;
    height?: number | null;
    fileSize?: number | null;
    fileName?: string | null;
}

interface SynologyPhotoItem {
    id?: string | number;
    filename?: string;
    filesize?: number;
    time?: number;
    item_count?: number;
    name?: string;
    additional?: {
        thumbnail?: { cache_key?: string };
        address?: { city?: string; country?: string; state?: string };
        resolution?: { width?: number; height?: number };
        exif?: {
            camera?: string;
            lens?: string;
            focal_length?: string | number;
            aperture?: string | number;
            exposure_time?: string | number;
            iso?: string | number;
        };
        gps?: { latitude?: number; longitude?: number };
        orientation?: number;
        description?: string;
    };
}

type SynologyUserRecord = {
    synology_url?: string | null;
    synology_username?: string | null;
    synology_password?: string | null;
    synology_sid?: string | null;
};

function readSynologyUser(userId: number, columns: string[]): SynologyUserRecord | null {
    try {

        if (!columns) return null;

        const row = db.prepare(`SELECT synology_url, synology_username, synology_password, synology_sid FROM users WHERE id = ?`).get(userId) as SynologyUserRecord | undefined;

        if (!row) return null;

        const filtered: SynologyUserRecord = {};
        for (const column of columns) {
            filtered[column] = row[column];
        }

        return filtered || null;
    } catch {
        return null;
    }
}

function getSynologyCredentials(userId: number): SynologyCredentials | null {
    const user = readSynologyUser(userId, ['synology_url', 'synology_username', 'synology_password']);
    if (!user?.synology_url || !user.synology_username || !user.synology_password) return null;
    return {
        synology_url: user.synology_url,
        synology_username: user.synology_username,
        synology_password: decrypt_api_key(user.synology_password) as string,
    };
}


function buildSynologyEndpoint(url: string): string {
    const normalized = url.replace(/\/$/, '').match(/^https?:\/\//) ? url.replace(/\/$/, '') : `https://${url.replace(/\/$/, '')}`;
    return `${normalized}${SYNOLOGY_ENDPOINT_PATH}`;
}

function buildSynologyFormBody(params: ApiCallParams): URLSearchParams {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return body;
}

async function fetchSynologyJson<T>(url: string, body: URLSearchParams): Promise<SynologyApiResponse<T>> {
    const endpoint = buildSynologyEndpoint(url);
    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body,
        signal: AbortSignal.timeout(SYNOLOGY_API_TIMEOUT_MS),
    });

    if (!resp.ok) {
        const text = await resp.text();
        return { success: false, error: { code: resp.status, message: text } };
    }

    return resp.json() as Promise<SynologyApiResponse<T>>;
}

async function loginToSynology(url: string, username: string, password: string): Promise<SynologyApiResponse<{ sid?: string }>> {
    const body = new URLSearchParams({
        api: 'SYNO.API.Auth',
        method: 'login',
        version: '3',
        account: username,
        passwd: password,
    });

    return fetchSynologyJson<{ sid?: string }>(url, body);
}

async function requestSynologyApi<T>(userId: number, params: ApiCallParams): Promise<SynologyApiResponse<T>> {
    const creds = getSynologyCredentials(userId);
    if (!creds) {
        return { success: false, error: { code: 400, message: 'Synology not configured' } };
    }

    const session = await getSynologySession(userId);
    if (!session.success || !session.sid) {
        return { success: false, error: session.error || { code: 400, message: 'Failed to get Synology session' } };
    }

    const body = buildSynologyFormBody({ ...params, _sid: session.sid });
    const result = await fetchSynologyJson<T>(creds.synology_url, body);
    if (!result.success && result.error?.code === 119) {
        clearSynologySID(userId);
        const retrySession = await getSynologySession(userId);
        if (!retrySession.success || !retrySession.sid) {
            return { success: false, error: retrySession.error || { code: 400, message: 'Failed to get Synology session' } };
        }
        return fetchSynologyJson<T>(creds.synology_url, buildSynologyFormBody({ ...params, _sid: retrySession.sid }));
    }
    return result;
}

async function requestSynologyStream(url: string): Promise<globalThis.Response> {
    return fetch(url, {
        signal: AbortSignal.timeout(SYNOLOGY_API_TIMEOUT_MS),
    });
}

function normalizeSynologyPhotoInfo(item: SynologyPhotoItem): SynologyPhotoInfo {
    const address = item.additional?.address || {};
    const exif = item.additional?.exif || {};
    const gps = item.additional?.gps || {};

    return {
        id: String(item.additional?.thumbnail?.cache_key || ''),
        takenAt: item.time ? new Date(item.time * 1000).toISOString() : null,
        city: address.city || null,
        country: address.country || null,
        state: address.state || null,
        camera: exif.camera || null,
        lens: exif.lens || null,
        focalLength: exif.focal_length || null,
        aperture: exif.aperture || null,
        shutter: exif.exposure_time || null,
        iso: exif.iso || null,
        lat: gps.latitude || null,
        lng: gps.longitude || null,
        orientation: item.additional?.orientation || null,
        description: item.additional?.description || null,
        filename: item.filename || null,
        filesize: item.filesize || null,
        width: item.additional?.resolution?.width || null,
        height: item.additional?.resolution?.height || null,
        fileSize: item.filesize || null,
        fileName: item.filename || null,
    };
}

export function handleSynologyError(res: ExpressResponse, err: unknown, fallbackMessage: string): ExpressResponse {
    if (err instanceof SynologyServiceError) {
        return res.status(err.status).json({ error: err.message });
    }
    return res.status(502).json({ error: err instanceof Error ? err.message : fallbackMessage });
}

function cacheSynologySID(userId: number, sid: string): void {
    db.prepare('UPDATE users SET synology_sid = ? WHERE id = ?').run(sid, userId);
}

function clearSynologySID(userId: number): void {
    db.prepare('UPDATE users SET synology_sid = NULL WHERE id = ?').run(userId);
}

function splitPackedSynologyId(rawId: string): { id: string; cacheKey: string; assetId: string } {
    const id = rawId.split('_')[0];
    return { id, cacheKey: rawId, assetId: rawId };
}


async function getSynologySession(userId: number): Promise<SynologySession> {
    const cachedSid = readSynologyUser(userId, ['synology_sid'])?.synology_sid || null;
    if (cachedSid) {
        return { success: true, sid: cachedSid };
    }
    
    const creds = getSynologyCredentials(userId);
    if (!creds) {
        return { success: false, error: { code: 400, message: 'Invalid Synology credentials' } };
    }

    const resp = await loginToSynology(creds.synology_url, creds.synology_username, creds.synology_password);

    if (!resp.success || !resp.data?.sid) {
        return { success: false, error: resp.error || { code: 400, message: 'Failed to authenticate with Synology' } };
    }

    cacheSynologySID(userId, resp.data.sid);
    return { success: true, sid: resp.data.sid };
}

export async function getSynologySettings(userId: number): Promise<SynologySettings> {
    const creds = getSynologyCredentials(userId);
    const session = await getSynologySession(userId);
    return {
        synology_url: creds?.synology_url || '',
        synology_username: creds?.synology_username || '',
        connected: session.success,
    };
}

export async function updateSynologySettings(userId: number, synologyUrl: string, synologyUsername: string, synologyPassword?: string): Promise<void> {

    const ssrf = await checkSsrf(synologyUrl);
    if (!ssrf.allowed) {
        throw new SynologyServiceError(400, ssrf.error ?? 'Invalid Synology URL');
    }

    const existingEncryptedPassword = readSynologyUser(userId, ['synology_password'])?.synology_password || null;

    if (!synologyPassword && !existingEncryptedPassword) {
        throw new SynologyServiceError(400, 'No stored password found. Please provide a password to save settings.');
    }

    try {
        db.prepare('UPDATE users SET synology_url = ?, synology_username = ?, synology_password = ? WHERE id = ?').run(
            synologyUrl,
            synologyUsername,
            synologyPassword ? maybe_encrypt_api_key(synologyPassword) : existingEncryptedPassword,
            userId,
        );
    } catch {
        throw new SynologyServiceError(400, 'Failed to save settings');
    }

    clearSynologySID(userId);
    await getSynologySession(userId);
}

export async function getSynologyStatus(userId: number): Promise<SynologyConnectionResult> {
    try {
        const sid = await getSynologySession(userId);
        if (!sid.success || !sid.sid) {
            return { connected: false, error: 'Authentication failed' };
        }

        const user = db.prepare('SELECT synology_username FROM users WHERE id = ?').get(userId) as { synology_username?: string } | undefined;
        return { connected: true, user: { username: user?.synology_username || '' } };
    } catch (err: unknown) {
        return { connected: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
}

export async function testSynologyConnection(synologyUrl: string, synologyUsername: string, synologyPassword: string): Promise<SynologyConnectionResult> {

    const ssrf = await checkSsrf(synologyUrl);
    if (!ssrf.allowed) {
        return { connected: false, error: ssrf.error ?? 'Invalid Synology URL' };
    }
    try {
        const login = await loginToSynology(synologyUrl, synologyUsername, synologyPassword);
        if (!login.success || !login.data?.sid) {
            return { connected: false, error: login.error?.message || 'Authentication failed' };
        }
        return { connected: true, user: { username: synologyUsername } };
    } catch (err: unknown) {
        return { connected: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
}

export async function listSynologyAlbums(userId: number): Promise<{ albums: Array<{ id: string; albumName: string; assetCount: number }> }> {
    const result = await requestSynologyApi<{ list: SynologyPhotoItem[] }>(userId, {
        api: 'SYNO.Foto.Browse.Album',
        method: 'list',
        version: 4,
        offset: 0,
        limit: 100,
    });

    if (!result.success || !result.data) {
        throw new SynologyServiceError(result.error?.code || 500, result.error?.message || 'Failed to fetch albums');
    }

    const albums = (result.data.list || []).map((album: SynologyPhotoItem) => ({
        id: String(album.id),
        albumName: album.name || '',
        assetCount: album.item_count || 0,
    }));

    return { albums };
}


export async function syncSynologyAlbumLink(userId: number, tripId: string, linkId: string): Promise<{ added: number; total: number }> {
    const response = getAlbumIdFromLink(tripId, linkId, userId);
    if (!response.success) {
        throw new SynologyServiceError(404, 'Album link not found');
    }

    const allItems: SynologyPhotoItem[] = [];
    const pageSize = 1000;
    let offset = 0;

    while (true) {
        const result = await requestSynologyApi<{ list: SynologyPhotoItem[] }>(userId, {
            api: 'SYNO.Foto.Browse.Item',
            method: 'list',
            version: 1,
            album_id: Number(response.data),
            offset,
            limit: pageSize,
            additional: ['thumbnail'],
        });

        if (!result.success || !result.data) {
            throw new SynologyServiceError(502, result.error?.message || 'Failed to fetch album');
        }

        const items = result.data.list || [];
        allItems.push(...items);
        if (items.length < pageSize) break;
        offset += pageSize;
    }

    const selection: Selection = {
        provider: SYNOLOGY_PROVIDER,
        asset_ids: allItems.map(item => String(item.additional?.thumbnail?.cache_key || '')).filter(id => id),
    };

    updateSyncTimeForAlbumLink(linkId);

    const result = await addTripPhotos(tripId, userId, true, [selection]);
    if ('error' in result) throw new SynologyServiceError(result.error.status, result.error.message);

    return { added: result.data.added, total: allItems.length };
}

export async function searchSynologyPhotos(userId: number, from?: string, to?: string, offset = 0, limit = 300): Promise<{ assets: SynologyPhotoInfo[]; total: number; hasMore: boolean }> {
    const params: ApiCallParams = {
        api: 'SYNO.Foto.Search.Search',
        method: 'list_item',
        version: 1,
        offset,
        limit,
        keyword: '.',
        additional: ['thumbnail', 'address'],
    };

    if (from || to) {
        if (from) {
            params.start_time = Math.floor(new Date(from).getTime() / 1000);
        }
        if (to) {
            params.end_time = Math.floor(new Date(to).getTime() / 1000) + 86400; //adding it as the next day 86400 seconds in day
        }
    }

    const result = await requestSynologyApi<{ list: SynologyPhotoItem[]; total: number }>(userId, params);
    if (!result.success || !result.data) {
        throw new SynologyServiceError(502, result.error?.message || 'Failed to fetch album photos');
    }

    const allItems = result.data.list || [];
    const total = allItems.length;
    const assets = allItems.map(item => normalizeSynologyPhotoInfo(item));

    return {
        assets,
        total,
        hasMore: total === limit,
    };
}

export async function getSynologyAssetInfo(userId: number, photoId: string, targetUserId?: number): Promise<SynologyPhotoInfo> {
    const parsedId = splitPackedSynologyId(photoId);
    const result = await requestSynologyApi<{ list: SynologyPhotoItem[] }>(targetUserId ?? userId, {
        api: 'SYNO.Foto.Browse.Item',
        method: 'get',
        version: 5,
        id: `[${parsedId.id}]`,
        additional: ['resolution', 'exif', 'gps', 'address', 'orientation', 'description'],
    });

    if (!result.success || !result.data) {
        throw new SynologyServiceError(404, 'Photo not found');
    }

    const metadata = result.data.list?.[0];
    if (!metadata) {
        throw new SynologyServiceError(404, 'Photo not found');
    }

    const normalized = normalizeSynologyPhotoInfo(metadata);
    normalized.id = photoId;
    return normalized;
}

export async function streamSynologyAsset(
    userId: number,
    targetUserId: number,
    photoId: string,
    kind: 'thumbnail' | 'original',
    size?: string,
): Promise<SynologyProxyResult> {    
    const parsedId = splitPackedSynologyId(photoId);
    const synology_url = getSynologyCredentials(targetUserId).synology_url;
    if (!synology_url) {
        throw new SynologyServiceError(402, 'User not configured with Synology');
    }

    const sid = await getSynologySession(targetUserId);
    if (!sid.success || !sid.sid) {
        throw new SynologyServiceError(401, 'Authentication failed');
    }

    

    const params = kind === 'thumbnail'
        ? new URLSearchParams({
            api: 'SYNO.Foto.Thumbnail',
            method: 'get',
            version: '2',
            mode: 'download',
            id: parsedId.id,
            type: 'unit',
            size: String(size || SYNOLOGY_DEFAULT_THUMBNAIL_SIZE),
            cache_key: parsedId.cacheKey,
            _sid: sid.sid,
        })
        : new URLSearchParams({
            api: 'SYNO.Foto.Download',
            method: 'download',
            version: '2',
            cache_key: parsedId.cacheKey,
            unit_id: `[${parsedId.id}]`,
            _sid: sid.sid,
        });

    const url = `${buildSynologyEndpoint(synology_url)}?${params.toString()}`;
    const resp = await requestSynologyStream(url);

    if (!resp.ok) {
        const body = kind === 'original' ? await resp.text() : 'Failed';
        throw new SynologyServiceError(resp.status, kind === 'original' ? `Failed: ${body}` : body);
    }

    return {
        status: resp.status,
        headers: {
            'content-type': resp.headers.get('content-type') || (kind === 'thumbnail' ? 'image/jpeg' : 'application/octet-stream'),
            'cache-control': resp.headers.get('cache-control') || 'public, max-age=86400',
            'content-length': resp.headers.get('content-length'),
            'content-disposition': resp.headers.get('content-disposition'),
        },
        body: resp.body,
    };
}

export async function pipeSynologyProxy(response: ExpressResponse, proxy: SynologyProxyResult): Promise<void> {
    response.status(proxy.status);
    if (proxy.headers['content-type']) response.set('Content-Type', proxy.headers['content-type'] as string);
    if (proxy.headers['cache-control']) response.set('Cache-Control', proxy.headers['cache-control'] as string);
    if (proxy.headers['content-length']) response.set('Content-Length', proxy.headers['content-length'] as string);
    if (proxy.headers['content-disposition']) response.set('Content-Disposition', proxy.headers['content-disposition'] as string);

    if (!proxy.body) {
        response.end();
        return;
    }

    await pipeline(Readable.fromWeb(proxy.body), response);
}
