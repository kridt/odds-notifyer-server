// services/oddsCache.js
// Centralized odds caching service with rate limiting

const ODDS_API_KEY = process.env.ODDS_API_KEY || '811e5fb0efa75d2b92e800cb55b60b30f62af8c21da06c4b2952eb516bee0a2e';
const ODDS_API_BASE = process.env.ODDS_API_BASE || 'https://api2.odds-api.io/v3';
const MAX_CALLS_PER_HOUR = parseInt(process.env.MAX_CALLS_PER_HOUR) || 5000;

// Bookmakers configuration (Sporttrade removed - returns 400 errors)
const NBA_BOOKMAKERS = [
  'Kambi', 'Bet365', 'DraftKings', 'Pinnacle', 'BetMGM', 'Caesars', 'PrizePicks', 'FanDuel',
  'BetOnline.ag', 'BetPARX', 'BetRivers', 'Bovada', 'Fanatics', 'Fliff', 'Superbet', 'Underdog', 'Bally Bet'
];

const FOOTBALL_BOOKMAKERS = [
  'Pinnacle', 'Bet365', 'Kambi', 'DraftKings', 'FanDuel', 'BetMGM', 'Caesars',
  'BetOnline.ag', 'BetRivers', 'Bovada', 'Fanatics', 'Superbet', 'Bally Bet'
];

// Football leagues to track (matches frontend config)
const FOOTBALL_LEAGUES = [
  // Top 5 + second divisions
  'england-premier-league',
  'england-championship',
  'england-fa-cup',
  'spain-laliga',
  'spain-laliga-2',
  'germany-bundesliga',
  'germany-2-bundesliga',
  'italy-serie-a',
  'italy-serie-b',
  'france-ligue-1',
  'france-ligue-2',
  // European leagues
  'netherlands-eredivisie',
  'portugal-liga-portugal',
  'belgium-pro-league',
  'scotland-premiership',
  'denmark-superliga',
  'austria-bundesliga',
  'greece-super-league',
  // UEFA competitions
  'international-clubs-uefa-champions-league',
  'international-clubs-uefa-europa-league',
  'international-clubs-uefa-conference-league',
  // Other
  'saudi-arabia-saudi-pro-league',
  'brazil-brasileiro-serie-a',
  'argentina-liga-profesional'
];

class OddsCache {
  constructor() {
    // Cache storage
    this.nbaEvents = [];
    this.nbaOdds = {}; // { eventId: { bookmaker: oddsData } }
    this.footballEvents = {}; // { leagueSlug: events[] }
    this.footballOdds = {}; // { eventId: { bookmaker: oddsData } }

    // Rate limiting
    this.apiCallsThisHour = 0;
    this.hourStartTime = Date.now();

    // Last update timestamps
    this.lastNbaEventsUpdate = null;
    this.lastNbaOddsUpdate = null;
    this.lastFootballEventsUpdate = {};
    this.lastFootballOddsUpdate = null;

    // Status tracking
    this.isRefreshing = false;
    this.lastError = null;
  }

  // Check and reset hourly rate limit
  checkRateLimit() {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;

    if (now - this.hourStartTime >= hourMs) {
      console.log(`[RateLimit] Resetting hourly counter. Used ${this.apiCallsThisHour} calls last hour.`);
      this.apiCallsThisHour = 0;
      this.hourStartTime = now;
    }

    return this.apiCallsThisHour < MAX_CALLS_PER_HOUR;
  }

  getRemainingCalls() {
    this.checkRateLimit();
    return MAX_CALLS_PER_HOUR - this.apiCallsThisHour;
  }

  // Generic fetch with rate limiting
  async fetchWithRateLimit(url, description = '') {
    if (!this.checkRateLimit()) {
      console.log(`[RateLimit] Limit reached (${this.apiCallsThisHour}/${MAX_CALLS_PER_HOUR}). Skipping: ${description}`);
      return null;
    }

    try {
      this.apiCallsThisHour++;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`[API ${this.apiCallsThisHour}/${MAX_CALLS_PER_HOUR}] ${description}`);
      return data;
    } catch (error) {
      console.error(`[API Error] ${description}: ${error.message}`);
      this.lastError = { time: new Date(), message: error.message, url };
      return null;
    }
  }

  // ==================== NBA FETCHING ====================

  async fetchNbaEvents() {
    // Format date in RFC3339 format (required by API)
    const toDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const toDateStr = toDate.toISOString(); // e.g., 2025-12-16T23:59:59.999Z

    const url = `${ODDS_API_BASE}/events?apiKey=${ODDS_API_KEY}&sport=basketball&league=usa-nba&status=pending&to=${toDateStr}`;
    const data = await this.fetchWithRateLimit(url, 'NBA events');

    if (data && Array.isArray(data)) {
      this.nbaEvents = data;
      this.lastNbaEventsUpdate = new Date();
      console.log(`[NBA] Cached ${data.length} events`);
    }

    return this.nbaEvents;
  }

  async fetchNbaOddsForEvent(eventId) {
    // Fetch each bookmaker individually to avoid API limits
    const eventOdds = { bookmakers: {}, cachedAt: new Date() };

    for (const bookmaker of NBA_BOOKMAKERS) {
      if (!this.checkRateLimit()) break;

      const url = `${ODDS_API_BASE}/odds?apiKey=${ODDS_API_KEY}&eventId=${eventId}&bookmakers=${bookmaker}`;
      const data = await this.fetchWithRateLimit(url, `NBA odds ${eventId} - ${bookmaker}`);

      if (data && data.bookmakers && data.bookmakers[bookmaker]) {
        eventOdds.bookmakers[bookmaker] = data.bookmakers[bookmaker];
        eventOdds.home = data.home;
        eventOdds.away = data.away;
        eventOdds.date = data.date;
      }

      await this.sleep(50); // Small delay between requests
    }

    this.nbaOdds[eventId] = eventOdds;
    return eventOdds;
  }

  async refreshNbaOdds() {
    if (this.nbaEvents.length === 0) {
      await this.fetchNbaEvents();
    }

    // Sort events by date, prioritize upcoming matches
    const sortedEvents = [...this.nbaEvents].sort((a, b) =>
      new Date(a.date) - new Date(b.date)
    );

    // Only fetch odds for matches in the next 3 days to save API calls
    const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const upcomingEvents = sortedEvents.filter(e => new Date(e.date) <= threeDaysFromNow);

    console.log(`[NBA] Refreshing odds for ${upcomingEvents.length} upcoming events...`);

    for (const event of upcomingEvents) {
      if (!this.checkRateLimit()) {
        console.log('[NBA] Rate limit reached, stopping refresh');
        break;
      }
      await this.fetchNbaOddsForEvent(event.id);
      await this.sleep(100); // Small delay between requests
    }

    this.lastNbaOddsUpdate = new Date();
  }

  // ==================== FOOTBALL FETCHING ====================

  async fetchFootballEvents(leagueSlug) {
    // Format date in RFC3339 format (required by API)
    const toDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const toDateStr = toDate.toISOString(); // e.g., 2025-12-16T23:59:59.999Z

    const url = `${ODDS_API_BASE}/events?apiKey=${ODDS_API_KEY}&sport=football&league=${leagueSlug}&status=pending&to=${toDateStr}`;
    const data = await this.fetchWithRateLimit(url, `Football events for ${leagueSlug}`);

    if (data && Array.isArray(data)) {
      this.footballEvents[leagueSlug] = data;
      this.lastFootballEventsUpdate[leagueSlug] = new Date();
      console.log(`[Football] Cached ${data.length} events for ${leagueSlug}`);
    }

    return this.footballEvents[leagueSlug] || [];
  }

  async fetchFootballOddsForEvent(eventId, bookmakers = FOOTBALL_BOOKMAKERS) {
    // Fetch one bookmaker at a time to handle the API structure
    const eventOdds = { bookmakers: {}, cachedAt: new Date() };

    for (const bookmaker of bookmakers) {
      if (!this.checkRateLimit()) break;

      const url = `${ODDS_API_BASE}/odds?apiKey=${ODDS_API_KEY}&eventId=${eventId}&bookmakers=${bookmaker}`;
      const data = await this.fetchWithRateLimit(url, `Football odds ${eventId} - ${bookmaker}`);

      if (data && data.bookmakers && data.bookmakers[bookmaker]) {
        eventOdds.bookmakers[bookmaker] = data.bookmakers[bookmaker];
        eventOdds.urls = { ...eventOdds.urls, ...data.urls };
        eventOdds.home = data.home;
        eventOdds.away = data.away;
        eventOdds.date = data.date;
      }

      await this.sleep(50);
    }

    this.footballOdds[eventId] = eventOdds;
    return eventOdds;
  }

  async refreshFootballOdds() {
    // Fetch events for all leagues
    for (const league of FOOTBALL_LEAGUES) {
      if (!this.checkRateLimit()) break;
      await this.fetchFootballEvents(league);
      await this.sleep(100);
    }

    // Collect all upcoming events across leagues
    const allEvents = [];
    for (const league of FOOTBALL_LEAGUES) {
      const events = this.footballEvents[league] || [];
      allEvents.push(...events.map(e => ({ ...e, league })));
    }

    // Sort by date, prioritize upcoming
    const sortedEvents = allEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Only fetch odds for matches in the next 3 days
    const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const upcomingEvents = sortedEvents.filter(e => new Date(e.date) <= threeDaysFromNow);

    console.log(`[Football] Refreshing odds for ${upcomingEvents.length} upcoming events...`);

    for (const event of upcomingEvents) {
      if (!this.checkRateLimit()) {
        console.log('[Football] Rate limit reached, stopping refresh');
        break;
      }
      await this.fetchFootballOddsForEvent(event.id);
      await this.sleep(100);
    }

    this.lastFootballOddsUpdate = new Date();
  }

  // ==================== FULL REFRESH ====================

  async refreshAll() {
    if (this.isRefreshing) {
      console.log('[Cache] Already refreshing, skipping...');
      return;
    }

    this.isRefreshing = true;
    console.log(`\n========== STARTING FULL REFRESH ==========`);
    console.log(`[Cache] API calls remaining: ${this.getRemainingCalls()}`);

    try {
      // Fetch NBA
      await this.fetchNbaEvents();
      await this.refreshNbaOdds();

      // Fetch Football
      await this.refreshFootballOdds();

      console.log(`========== REFRESH COMPLETE ==========`);
      console.log(`[Cache] API calls used this hour: ${this.apiCallsThisHour}/${MAX_CALLS_PER_HOUR}`);
    } catch (error) {
      console.error('[Cache] Refresh error:', error);
      this.lastError = { time: new Date(), message: error.message };
    } finally {
      this.isRefreshing = false;
    }
  }

  // ==================== GETTERS ====================

  getNbaEvents() {
    return {
      events: this.nbaEvents,
      lastUpdate: this.lastNbaEventsUpdate,
      count: this.nbaEvents.length
    };
  }

  getNbaOdds(eventId) {
    if (eventId) {
      return this.nbaOdds[eventId] || null;
    }
    return this.nbaOdds;
  }

  getAllNbaOdds() {
    return {
      odds: this.nbaOdds,
      lastUpdate: this.lastNbaOddsUpdate,
      eventCount: Object.keys(this.nbaOdds).length
    };
  }

  getFootballEvents(leagueSlug) {
    if (leagueSlug) {
      return {
        events: this.footballEvents[leagueSlug] || [],
        lastUpdate: this.lastFootballEventsUpdate[leagueSlug],
        count: (this.footballEvents[leagueSlug] || []).length
      };
    }

    return {
      events: this.footballEvents,
      lastUpdate: this.lastFootballEventsUpdate,
      leagues: Object.keys(this.footballEvents)
    };
  }

  getFootballOdds(eventId) {
    if (eventId) {
      return this.footballOdds[eventId] || null;
    }
    return this.footballOdds;
  }

  getAllFootballOdds() {
    return {
      odds: this.footballOdds,
      lastUpdate: this.lastFootballOddsUpdate,
      eventCount: Object.keys(this.footballOdds).length
    };
  }

  getStatus() {
    return {
      apiCallsThisHour: this.apiCallsThisHour,
      maxCallsPerHour: MAX_CALLS_PER_HOUR,
      remainingCalls: this.getRemainingCalls(),
      isRefreshing: this.isRefreshing,
      lastError: this.lastError,
      nba: {
        eventsCount: this.nbaEvents.length,
        oddsCount: Object.keys(this.nbaOdds).length,
        lastEventsUpdate: this.lastNbaEventsUpdate,
        lastOddsUpdate: this.lastNbaOddsUpdate
      },
      football: {
        leagues: Object.keys(this.footballEvents),
        eventsCount: Object.values(this.footballEvents).flat().length,
        oddsCount: Object.keys(this.footballOdds).length,
        lastOddsUpdate: this.lastFootballOddsUpdate
      }
    };
  }

  // Utility
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
const cache = new OddsCache();

module.exports = cache;
