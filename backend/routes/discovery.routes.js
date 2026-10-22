const express = require('express');
const router = express.Router();
const { protect, optionalProtect, authorize } = require('../middleware/auth.middleware');
const { listPosts, listMyPosts, signUpload, createPost, updatePost, deletePost } = require('../controllers/discovery.controller');

router.get('/posts', optionalProtect, listPosts);
router.get('/mine', protect, authorize('chef'), listMyPosts);
router.post('/uploads/signature', protect, authorize('chef'), signUpload);
router.post('/posts', protect, authorize('chef'), createPost);
router.put('/posts/:id', protect, authorize('chef'), updatePost);
router.delete('/posts/:id', protect, authorize('chef'), deletePost);

module.exports = router;
