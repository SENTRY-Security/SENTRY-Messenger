import { Router } from 'express';
import {
  deleteContact
} from '../controllers/friends.controller.js';

const r = Router();

r.post('/friends/delete', deleteContact);

export default r;
