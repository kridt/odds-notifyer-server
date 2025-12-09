// server.js
// Centralized odds caching server for NBA and Football EV calculations

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const oddsCache = require('./services/oddsCache');

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware - CORS with explicit configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// ==================== API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Get cache status
app.get('/api/status', (req, res) => {
  res.json(oddsCache.getStatus());
});

// ==================== NBA ROUTES ====================

// Get NBA events
app.get('/api/nba/events', (req, res) => {
  const data = oddsCache.getNbaEvents();
  res.json(data);
});

// Get NBA odds for specific event
app.get('/api/nba/odds/:eventId', (req, res) => {
  const { eventId } = req.params;
  const odds = oddsCache.getNbaOdds(eventId);

  if (!odds) {
    return res.status(404).json({ error: 'Odds not found for this event' });
  }

  res.json(odds);
});

// Get all NBA odds
app.get('/api/nba/odds', (req, res) => {
  const data = oddsCache.getAllNbaOdds();
  res.json(data);
});

// Get combined NBA data (events + odds)
app.get('/api/nba/all', (req, res) => {
  const events = oddsCache.getNbaEvents();
  const odds = oddsCache.getAllNbaOdds();

  // Combine events with their odds
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

// Get football events (optionally by league)
app.get('/api/football/events', (req, res) => {
  const { league } = req.query;
  const data = oddsCache.getFootballEvents(league);
  res.json(data);
});

// Get football events for specific league
app.get('/api/football/events/:league', (req, res) => {
  const { league } = req.params;
  const data = oddsCache.getFootballEvents(league);
  res.json(data);
});

// Get football odds for specific event
app.get('/api/football/odds/:eventId', (req, res) => {
  const { eventId } = req.params;
  const odds = oddsCache.getFootballOdds(eventId);

  if (!odds) {
    return res.status(404).json({ error: 'Odds not found for this event' });
  }

  res.json(odds);
});

// Get all football odds
app.get('/api/football/odds', (req, res) => {
  const data = oddsCache.getAllFootballOdds();
  res.json(data);
});

// Get combined football data for a league
app.get('/api/football/all/:league', (req, res) => {
  const { league } = req.params;
  const events = oddsCache.getFootballEvents(league);
  const allOdds = oddsCache.getAllFootballOdds();

  // Combine events with their odds
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

// Get all football data across all leagues
app.get('/api/football/all', (req, res) => {
  const events = oddsCache.getFootballEvents();
  const allOdds = oddsCache.getAllFootballOdds();

  // Combine all events with their odds
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

// Manually trigger a refresh
app.post('/api/admin/refresh', async (req, res) => {
  const { type } = req.body; // 'nba', 'football', or 'all'

  res.json({ message: 'Refresh started', type: type || 'all' });

  // Run refresh in background
  if (type === 'nba') {
    oddsCache.fetchNbaEvents().then(() => oddsCache.refreshNbaOdds());
  } else if (type === 'football') {
    oddsCache.refreshFootballOdds();
  } else {
    oddsCache.refreshAll();
  }
});

// ==================== SCHEDULER ====================

// Refresh every 10 minutes
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || '*/10 * * * *';

cron.schedule(REFRESH_INTERVAL, () => {
  console.log(`\n[Scheduler] Starting scheduled refresh at ${new Date().toISOString()}`);
  oddsCache.refreshAll();
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║         ODDS NOTIFYER SERVER                              ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║  API calls limit: 5000/hour                               ║
║  Refresh interval: Every 10 minutes                       ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                               ║
║  GET  /api/status           - Cache status                ║
║  GET  /api/nba/events       - NBA events                  ║
║  GET  /api/nba/odds/:id     - NBA odds for event          ║
║  GET  /api/nba/all          - All NBA data                ║
║  GET  /api/football/events  - Football events             ║
║  GET  /api/football/odds/:id - Football odds for event    ║
║  GET  /api/football/all     - All football data           ║
║  POST /api/admin/refresh    - Manual refresh              ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Initial fetch on startup
  console.log('[Startup] Starting initial data fetch...');
  oddsCache.refreshAll();
});
