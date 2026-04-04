import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
    listTripPhotos,
    listTripAlbumLinks,
    createTripAlbumLink,
    removeAlbumLink,
    addTripPhotos,
    removeTripPhoto,
    setTripPhotoSharing,
} from '../services/memoriesService';

const router = express.Router();

//------------------------------------------------
// routes for managing photos linked to trip

router.get('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
        const result = listTripPhotos(tripId, authReq.user.id);
        if ('error' in result) return res.status(result.error.status).json({ error: result.error.message });
        res.json({ photos: result.data });
});

router.post('/trips/:tripId/photos', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const sid = req.headers['x-socket-id'] as string;
    
    const shared = req.body?.shared === undefined ? true : !!req.body?.shared;
    const result = await addTripPhotos(
        tripId,
        authReq.user.id,
        shared,
        req.body?.selections || [],
        sid,
    );
    if ('error' in result) return res.status(result.error.status).json({ error: result.error.message });

    res.json({ success: true, added: result.data.added });
});

router.put('/trips/:tripId/photos/sharing', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = await setTripPhotoSharing(
        tripId,
        authReq.user.id,
        req.body?.provider,
        req.body?.asset_id,
        req.body?.shared,
    );
    if ('error' in result) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ success: true });
});

router.delete('/trips/:tripId/photos', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = await removeTripPhoto(tripId, authReq.user.id, req.body?.provider, req.body?.asset_id);
    if ('error' in result) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ success: true });
});

//------------------------------
// routes for managing album links

router.get('/trips/:tripId/album-links', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = listTripAlbumLinks(tripId, authReq.user.id);
    if ('error' in result) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ links: result.data });
});

router.post('/trips/:tripId/album-links', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = createTripAlbumLink(tripId, authReq.user.id, req.body?.provider, req.body?.album_id, req.body?.album_name);
    if ('error' in result) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ success: true });
});

router.delete('/trips/:tripId/album-links/:linkId', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, linkId } = req.params;
    const result = removeAlbumLink(tripId, linkId, authReq.user.id);
    if ('error' in result) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ success: true });
});

export default router;
