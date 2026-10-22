# Chef discovery media setup

Chef videos and photo collections are stored in Cloudinary; MongoDB stores only each asset's public ID and verified delivery metadata. Uploads are signed by Express and sent directly from the browser to Cloudinary. Keep `CLOUDINARY_API_SECRET` only in the backend environment.

## Configure Cloudinary

1. Create a Cloudinary account and open **Console → Settings → API Keys**.
2. Add these values to `backend/.env` locally and to the backend service's secret environment variables in production:

   ```env
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret
   CLOUDINARY_UPLOAD_PRESET=
   ```

3. Leave `CLOUDINARY_UPLOAD_PRESET` blank unless you created a **signed** upload preset. If you use one, add its name. The API secret must never be added to frontend files or committed.
4. Deploy the backend and frontend on the same allowed origin, set `NODE_ENV=production`, and set the production MongoDB URI. Ensure the Cloudinary account's storage and bandwidth quotas match expected video use.
5. Create the indexes in the same production database the app will use:

   ```sh
   cd backend
   npm run db:indexes:discovery
   ```

The API verifies each upload with Cloudinary before saving a post. It accepts JPEG, PNG, or WebP photos up to 10 MB each and up to six photos per collection. Videos must be MP4, WebM, or MOV, no larger than 50 MB and no longer than 30 seconds. A chef can edit or delete only their own posts; only active, approved chefs can publish. Media upload controls appear in the chef dashboard after approval.

Public discovery browsing works without Cloudinary configured, but chef uploads return a clear configuration error until all Cloudinary variables are set. Local end-to-end testing also requires a running MongoDB configured in `backend/.env` and the backend started with `npm run dev`; run `npm run test:flow` only against an isolated test database.
