import { Router } from 'express';
import { putReceiverCheckpoint, getLatestReceiverCheckpoint } from '../../controllers/receiver-checkpoints.controller.js';

const r = Router();

r.post('/receiver-checkpoints/put', putReceiverCheckpoint);
r.post('/receiver-checkpoints/get-latest', getLatestReceiverCheckpoint);

export default r;
