// server.js
// Real-time odds caching server with WebSocket for NBA and Football EV calculations

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createServer } = require('http');
const { Server } = require('socket.io');
const oddsCache = require('./services/oddsCache');

const app = express();
const httpServer = createServer(app);

// Socket.IO setup with CORS
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3002;

// Track connected clients
let connectedClients = 0;

// ==================== MIDDLEWARE ====================

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.options('*', cors());
app.use(express.json());

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
  connectedClients++;
  console.log(`[WS] Client connected (${connectedClients} total)`);

  // Send current status on connect
  socket.emit('status', oddsCache.getStatus());

  // Send current data snapshot
  socket.emit('snapshot', {
    nba: {
      events: oddsCache.getNbaEvents(),
      odds: oddsCache.getAllNbaOdds()
    },
    football: {
      events: oddsCache.getFootballEvents(),
      odds: oddsCache.getAllFootballOdds()
    }
  });

  // Handle client requesting specific data
  socket.on('subscribe', (data) => {
    if (data.sport === 'nba') {
      socket.join('nba');
      console.log(`[WS] Client subscribed to NBA`);
    }
    if (data.sport === 'football') {
      socket.join('football');
      console.log(`[WS] Client subscribed to Football`);
    }
  });

  // Handle manual refresh request
  socket.on('requestRefresh', async (data) => {
    console.log(`[WS] Client requested refresh: ${data?.type || 'all'}`);
    if (data?.type === 'nba') {
      await oddsCache.fetchNbaEvents();
      await oddsCache.refreshNbaOdds();
    } else if (data?.type === 'football') {
      await oddsCache.refreshFootballOdds();
    } else {
      await oddsCache.refreshAll();
    }
  });

  socket.on('disconnect', () => {
    connectedClients--;
    console.log(`[WS] Client disconnected (${connectedClients} remaining)`);
  });
});

// ==================== BROADCAST FUNCTIONS ====================

// Broadcast to all clients
const broadcast = (event, data) => {
  io.emit(event, data);
};

// Broadcast to specific sport subscribers
const broadcastToSport = (sport, event, data) => {
  io.to(sport).emit(event, data);
};

// Emit status updates periodically
const emitStatus = () => {
  broadcast('status', oddsCache.getStatus());
};

// ==================== HOOK INTO CACHE EVENTS ====================

// Extend oddsCache with event emitters
const originalRefreshAll = oddsCache.refreshAll.bind(oddsCache);
oddsCache.refreshAll = async function() {
  broadcast('refreshStart', { type: 'all', timestamp: new Date() });
  await originalRefreshAll();
  broadcast('refreshComplete', {
    type: 'all',
    timestamp: new Date(),
    status: this.getStatus()
  });

  // Send updated data
  broadcast('nbaUpdate', {
    events: this.getNbaEvents(),
    odds: this.getAllNbaOdds()
  });
  broadcast('footballUpdate', {
    events: this.getFootballEvents(),
    odds: this.getAllFootballOdds()
  });
};

const originalRefreshNbaOdds = oddsCache.refreshNbaOdds.bind(oddsCache);
oddsCache.refreshNbaOdds = async function() {
  broadcastToSport('nba', 'refreshStart', { type: 'nba', timestamp: new Date() });
  await originalRefreshNbaOdds();
  broadcastToSport('nba', 'nbaUpdate', {
    events: this.getNbaEvents(),
    odds: this.getAllNbaOdds()
  });
  emitStatus();
};

const originalRefreshFootballOdds = oddsCache.refreshFootballOdds.bind(oddsCache);
oddsCache.refreshFootballOdds = async function() {
  broadcastToSport('football', 'refreshStart', { type: 'football', timestamp: new Date() });
  await originalRefreshFootballOdds();
  broadcastToSport('football', 'footballUpdate', {
    events: this.getFootballEvents(),
    odds: this.getAllFootballOdds()
  });
  emitStatus();
};

// Hook into individual odds fetches to broadcast real-time updates
const originalFetchNbaOddsForEvent = oddsCache.fetchNbaOddsForEvent.bind(oddsCache);
oddsCache.fetchNbaOddsForEvent = async function(eventId) {
  const result = await originalFetchNbaOddsForEvent(eventId);
  broadcastToSport('nba', 'oddsUpdate', {
    sport: 'nba',
    eventId,
    odds: result,
    timestamp: new Date()
  });
  return result;
};

const originalFetchFootballOddsForEvent = oddsCache.fetchFootballOddsForEvent.bind(oddsCache);
oddsCache.fetchFootballOddsForEvent = async function(eventId, bookmakers) {
  const result = await originalFetchFootballOddsForEvent(eventId, bookmakers);
  broadcastToSport('football', 'oddsUpdate', {
    sport: 'football',
    eventId,
    odds: result,
    timestamp: new Date()
  });
  return result;
};

// ==================== API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    connectedClients,
    websocket: true
  });
});

// Get cache status
app.get('/api/status', (req, res) => {
  res.json({
    ...oddsCache.getStatus(),
    connectedClients,
    websocket: true
  });
});

// ==================== NBA ROUTES ====================

app.get('/api/nba/events', (req, res) => {
  res.json(oddsCache.getNbaEvents());
});

app.get('/api/nba/odds/:eventId', (req, res) => {
  const { eventId } = req.params;
  const odds = oddsCache.getNbaOdds(eventId);
  if (!odds) {
    return res.status(404).json({ error: 'Odds not found for this event' });
  }
  res.json(odds);
});

app.get('/api/nba/odds', (req, res) => {
  res.json(oddsCache.getAllNbaOdds());
});

app.get('/api/nba/all', (req, res) => {
  const events = oddsCache.getNbaEvents();
  const odds = oddsCache.getAllNbaOdds();
  const eventsWithOdds = events.events.map(event => ({
    ...event,
    odds: odds.odds[event.id] || null
  }));
  res.json({
    events: eventsWithOdds,
    lastEventsUpdate: events.lastUpdate,
    lastOddsUpdate: odds.lastUpdate,
    totalEvents: events.count,
    eventsWithOdds: eventsWithOdds.filter(e => e.odds).length
  });
});

// ==================== FOOTBALL ROUTES ====================

app.get('/api/football/events', (req, res) => {
  const { league } = req.query;
  res.json(oddsCache.getFootballEvents(league));
});

app.get('/api/football/events/:league', (req, res) => {
  const { league } = req.params;
  res.json(oddsCache.getFootballEvents(league));
});

app.get('/api/football/odds/:eventId', (req, res) => {
  const { eventId } = req.params;
  const odds = oddsCache.getFootballOdds(eventId);
  if (!odds) {
    return res.status(404).json({ error: 'Odds not found for this event' });
  }
  res.json(odds);
});

app.get('/api/football/odds', (req, res) => {
  res.json(oddsCache.getAllFootballOdds());
});

app.get('/api/football/all/:league', (req, res) => {
  const { league } = req.params;
  const events = oddsCache.getFootballEvents(league);
  const allOdds = oddsCache.getAllFootballOdds();
  const eventsWithOdds = (events.events || []).map(event => ({
    ...event,
    odds: allOdds.odds[event.id] || null
  }));
  res.json({
    league,
    events: eventsWithOdds,
    lastEventsUpdate: events.lastUpdate,
    lastOddsUpdate: allOdds.lastUpdate,
    totalEvents: events.count,
    eventsWithOdds: eventsWithOdds.filter(e => e.odds).length
  });
});

app.get('/api/football/all', (req, res) => {
  const events = oddsCache.getFootballEvents();
  const allOdds = oddsCache.getAllFootballOdds();
  const result = {};
  for (const league of events.leagues || []) {
    const leagueEvents = events.events[league] || [];
    result[league] = leagueEvents.map(event => ({
      ...event,
      odds: allOdds.odds[event.id] || null
    }));
  }
  res.json({
    leagues: result,
    lastOddsUpdate: allOdds.lastUpdate,
    totalEvents: Object.values(result).flat().length,
    eventsWithOdds: Object.values(result).flat().filter(e => e.odds).length
  });
});

// ==================== ADMIN ROUTES ====================

app.post('/api/admin/refresh', async (req, res) => {
  const { type } = req.body;
  res.json({ message: 'Refresh started', type: type || 'all' });

  if (type === 'nba') {
    oddsCache.fetchNbaEvents().then(() => oddsCache.refreshNbaOdds());
  } else if (type === 'football') {
    oddsCache.refreshFootballOdds();
  } else {
    oddsCache.refreshAll();
  }
});

// Get available leagues from OpticOdds (for debugging league IDs)
app.get('/api/leagues/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const leagues = await oddsCache.fetchAvailableLeagues(sport);
    res.json({ sport, count: leagues.length, leagues });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SCHEDULER ====================

const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || '*/2 * * * *';

cron.schedule(REFRESH_INTERVAL, () => {
  console.log(`\n[Scheduler] Starting scheduled refresh at ${new Date().toISOString()}`);
  broadcast('scheduledRefresh', { timestamp: new Date() });
  oddsCache.refreshAll();
});

// Emit status every 30 seconds
setInterval(emitStatus, 30000);

// ==================== START SERVER ====================

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         ODDS NOTIFYER SERVER v2.0 (WebSocket + OpticOdds)     ║
╠═══════════════════════════════════════════════════════════════╣
║  HTTP Server: port ${PORT}                                        ║
║  WebSocket:   enabled                                         ║
║  API:         OpticOdds (no rate limits)                      ║
║  Refresh:     Every 2 minutes                                 ║
╠═══════════════════════════════════════════════════════════════╣
║  REST Endpoints:                                              ║
║  GET  /api/status              - Cache status                 ║
║  GET  /api/nba/events          - NBA events                   ║
║  GET  /api/nba/odds/:id        - NBA odds for event           ║
║  GET  /api/nba/all             - All NBA data                 ║
║  GET  /api/football/events     - Football events              ║
║  GET  /api/football/odds/:id   - Football odds for event      ║
║  GET  /api/football/all        - All football data            ║
║  POST /api/admin/refresh       - Manual refresh               ║
╠═══════════════════════════════════════════════════════════════╣
║  WebSocket Events (Server -> Client):                         ║
║  - status           Status updates every 30s                  ║
║  - snapshot         Full data on connect                      ║
║  - refreshStart     Cache refresh starting                    ║
║  - refreshComplete  Cache refresh finished                    ║
║  - nbaUpdate        NBA data updated                          ║
║  - footballUpdate   Football data updated                     ║
║  - oddsUpdate       Individual event odds updated             ║
║  - scheduledRefresh Scheduled refresh triggered               ║
╠═══════════════════════════════════════════════════════════════╣
║  WebSocket Events (Client -> Server):                         ║
║  - subscribe        Subscribe to sport (nba/football)         ║
║  - requestRefresh   Request manual refresh                    ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  // Initial fetch on startup
  console.log('[Startup] Starting initial data fetch...');
  oddsCache.refreshAll();
});
