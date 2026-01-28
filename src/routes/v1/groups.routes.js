import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import {
  createGroup,
  addGroupMembers,
  removeGroupMembers,
  getGroup
} from '../../controllers/groups.controller.js';

const r = Router();

r.post('/groups/create', asyncH(createGroup));
r.post('/groups/members/add', asyncH(addGroupMembers));
r.post('/groups/members/remove', asyncH(removeGroupMembers));
r.get('/groups/:groupId', asyncH(getGroup));

export default r;
