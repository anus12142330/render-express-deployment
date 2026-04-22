export const notifyDashboardUpdate = (req) => {
  if (req.io) {
    req.io.emit('dashboard_update', { 
      timestamp: new Date().toISOString(),
      message: 'Dashboard data has been updated'
    });
    console.log('[SOCKET] Broadcasted dashboard_update event');
  } else {
    console.warn('[SOCKET] io instance not found in request');
  }
};
