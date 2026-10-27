const crypto = require('crypto');

const config = () => ({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || ''
});

const configured = () => {
    const c = config();
    return !!(c.cloudName && c.apiKey && c.apiSecret);
};

const sign = (params, secret) => {
    const serialized = Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
    return crypto.createHash('sha1').update(`${serialized}${secret}`).digest('hex');
};

const createUploadSignature = (chefId) => {
    const c = config();
    if (!configured()) {
        const err = new Error('Media uploads are not configured. Set the Cloudinary environment variables.');
        err.statusCode = 503;
        throw err;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `mymealchef/chef-${chefId}/discovery`;
    const publicId = `${folder}/${Date.now()}-${crypto.randomUUID()}`;
    const params = { public_id: publicId, timestamp };
    if (c.uploadPreset) params.upload_preset = c.uploadPreset;
    return {
        cloudName: c.cloudName,
        apiKey: c.apiKey,
        timestamp,
        folder,
        publicId,
        uploadPreset: c.uploadPreset || null,
        signature: sign(params, c.apiSecret)
    };
};

const getCloudinaryResource = async (resourceType, publicId) => {
    const c = config();
    const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloudName)}/resources/${resourceType}/upload/${encodeURIComponent(publicId)}`;
    const authorization = Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64');
    const response = await fetch(endpoint, { headers: { Authorization: `Basic ${authorization}` }, signal: AbortSignal.timeout(8000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Could not verify the uploaded media with Cloudinary. Please try again.');
    return response.json();
};

const verifyDiscoveryAsset = async ({ chefId, publicId, resourceType }) => {
    const c = config();
    if (!configured()) throw new Error('Media uploads are not configured.');
    if (!['image', 'video'].includes(resourceType) || typeof publicId !== 'string' || publicId.length > 220) {
        throw new Error('Invalid uploaded media reference.');
    }
    const folder = `mymealchef/chef-${chefId}/discovery/`;
    if (!publicId.startsWith(folder)) throw new Error('That media does not belong to your chef account.');
    const asset = await getCloudinaryResource(resourceType, publicId);
    if (!asset || asset.public_id !== publicId || asset.resource_type !== resourceType || !asset.secure_url) {
        throw new Error('Uploaded media could not be verified. Upload it again and retry.');
    }
    const secureUrl = new URL(asset.secure_url);
    if (secureUrl.protocol !== 'https:' || secureUrl.hostname !== 'res.cloudinary.com') throw new Error('Cloudinary returned an invalid media URL.');

    const format = String(asset.format || '').toLowerCase();
    const bytes = Number(asset.bytes) || 0;
    if (resourceType === 'image') {
        if (!['jpg', 'jpeg', 'png', 'webp'].includes(format) || bytes > 10 * 1024 * 1024) {
            throw new Error('Photos must be JPG, PNG or WebP files no larger than 10 MB.');
        }
        if ((Number(asset.width) || 0) * (Number(asset.height) || 0) > 40_000_000) throw new Error('That photo is too large to process.');
    } else {
        const duration = Number(asset.duration) || 0;
        if (!['mp4', 'webm', 'mov'].includes(format) || bytes > 50 * 1024 * 1024) {
            throw new Error('Videos must be MP4, WebM or MOV files no larger than 50 MB.');
        }
        if (!duration || duration > 30) throw new Error('Chef videos must be 30 seconds or shorter.');
    }

    return {
        publicId: asset.public_id,
        resourceType,
        secureUrl: asset.secure_url,
        format,
        bytes,
        duration: Number(asset.duration) || null,
        width: Number(asset.width) || null,
        height: Number(asset.height) || null,
        version: Number(asset.version)
    };
};

const deleteDiscoveryAsset = async (asset) => {
    const c = config();
    if (!configured() || !asset?.publicId || !['image', 'video'].includes(asset.resourceType)) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { invalidate: true, public_id: asset.publicId, timestamp };
    const body = new URLSearchParams({ ...params, api_key: c.apiKey, signature: sign(params, c.apiSecret) });
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloudName)}/${asset.resourceType}/destroy`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8000)
    });
    const result = await response.json();
    if (!response.ok || !['ok', 'not found'].includes(result.result)) throw new Error('Cloudinary could not remove one of this post’s media files.');
};

module.exports = { configured, createUploadSignature, verifyDiscoveryAsset, deleteDiscoveryAsset };
