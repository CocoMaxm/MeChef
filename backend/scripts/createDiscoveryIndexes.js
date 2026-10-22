// Run once against the intended production MongoDB after deploying discovery models.
// This creates the unique interaction index that prevents duplicate likes and saves.
require('dotenv').config();
const mongoose = require('mongoose');
const ChefPost = require('../models/ChefPost.model');
const UserInteraction = require('../models/UserInteraction.model');

async function main() {
    if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in backend/.env or the deployment environment.');
    await mongoose.connect(process.env.MONGODB_URI);
    await Promise.all([ChefPost.createIndexes(), UserInteraction.createIndexes()]);
    console.log('Discovery indexes created successfully.');
}

main().catch((err) => { console.error(`Could not create discovery indexes: ${err.message}`); process.exitCode = 1; })
    .finally(async () => { if (mongoose.connection.readyState) await mongoose.disconnect(); });
