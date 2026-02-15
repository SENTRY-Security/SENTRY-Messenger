import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import {
  inviteCall,
  cancelCall,
  acknowledgeCall,
  reportCallMetrics,
  getCallSession,
  getCallNetworkConfig,
  issueTurnCredentials
} from '../../controllers/calls.controller.js';

const r = Router();

r.post('/calls/invite', asyncH(inviteCall));
r.post('/calls/cancel', asyncH(cancelCall));
r.post('/calls/ack', asyncH(acknowledgeCall));
r.post('/calls/report-metrics', asyncH(reportCallMetrics));
r.get('/calls/network-config', asyncH(getCallNetworkConfig));
r.get('/calls/:callId', asyncH(getCallSession));
r.post('/calls/turn-credentials', asyncH(issueTurnCredentials));

export default r;
