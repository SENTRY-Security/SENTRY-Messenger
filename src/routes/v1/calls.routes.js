import { Router } from 'express';
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

r.post('/calls/invite', inviteCall);
r.post('/calls/cancel', cancelCall);
r.post('/calls/ack', acknowledgeCall);
r.post('/calls/report-metrics', reportCallMetrics);
r.get('/calls/network-config', getCallNetworkConfig);
r.get('/calls/:callId', getCallSession);
r.post('/calls/turn-credentials', issueTurnCredentials);

export default r;
