// services/oddsCache.js
// Centralized odds caching service - OPTICODDS API (no rate limits)

const OPTIC_API_KEY = process.env.OPTIC_ODDS_API_KEY || '';
const OPTIC_API_BASE = 'https://api.opticodds.com/api/v3';

// Bookmakers configuration
const NBA_BOOKMAKERS = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet',
  'bet365', 'pinnacle', 'bovada', 'betonline', 'betrivers',
  'unibet', 'wynnbet', 'superbook', 'barstool', 'hard_rock'
];

const FOOTBALL_BOOKMAKERS = [
  'pinnacle', 'bet365', 'draftkings', 'fanduel', 'betmgm', 'caesars',
  'betonline', 'betrivers', 'bovada', 'unibet', 'pointsbet'
];

// Football leagues to track (OpticOdds league IDs - format: country_-_league)
const FOOTBALL_LEAGUES = [
  // England
  'england_-_premier_league',
  'england_-_championship',
  'england_-_fa_cup',
  'england_-_efl_cup',
  'england_-_league_1',
  'england_-_league_2',
  // Spain
  'spain_-_la_liga',
  'spain_-_la_liga_2',
  // Germany
  'germany_-_bundesliga',
  'germany_-_bundesliga_2',
  // Italy
  'italy_-_serie_a',
  'italy_-_serie_b',
  // France
  'france_-_ligue_1',
  'france_-_ligue_2',
  // Other European leagues
  'netherlands_-_eredivisie',
  'portugal_-_primeira_liga',
  'belgium_-_jupiler_pro_league',
  'scotland_-_premiership',
  'denmark_-_superliga',
  'austria_-_bundesliga',
  'greece_-_super_league',
  // UEFA competitions
  'uefa_-_champions_league',
  'uefa_-_europa_league',
  'uefa_-_conference_league',
  // Other
  'saudi_arabia_-_pro_league',
  'brazil_-_serie_a',
  'argentina_-_primera_division'
];

class OddsCache {
  constructor() {
    // Cache storage
    this.nbaEvents = [];
    this.nbaOdds = {}; // { eventId: { bookmakers: {...} } }
    this.footballEvents = {}; // { leagueSlug: events[] }
    this.footballOdds = {}; // { eventId: { bookmakers: {...} } }

    // API call counter (for logging only)
    this.apiCallCount = 0;

    // Last update timestamps
    this.lastNbaEventsUpdate = null;
    this.lastNbaOddsUpdate = null;
    this.lastFootballEventsUpdate = {};
    this.lastFootballOddsUpdate = null;

    // Status tracking
    this.isRefreshing = false;
    this.lastError = null;
  }

  // Generic fetch - no rate limiting for OpticOdds
  async fetchApi(url, description = '') {
    if (!OPTIC_API_KEY) {
      console.error('[API Error] OPTIC_ODDS_API_KEY not configured');
      this.lastError = { time: new Date(), message: 'API key not configured' };
      return null;
    }

    try {
      this.apiCallCount++;
      const response = await fetch(url, {
        headers: {
          'x-api-key': OPTIC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`[API #${this.apiCallCount}] ${description}`);
      return data;
    } catch (error) {
      console.error(`[API Error] ${description}: ${error.message}`);
      this.lastError = { time: new Date(), message: error.message, url };
      return null;
    }
  }

  // ==================== NBA FETCHING ====================

  async fetchNbaEvents() {
    const url = `${OPTIC_API_BASE}/fixtures/active?league=nba`;
    const data = await this.fetchApi(url, 'NBA events');

    if (data && data.data && Array.isArray(data.data)) {
      // Transform to consistent format
      this.nbaEvents = data.data.map(event => ({
        id: event.id,
        home: event.home_team,
        away: event.away_team,
        date: event.start_date,
        league: 'nba',
        status: event.status
      }));
      this.lastNbaEventsUpdate = new Date();
      console.log(`[NBA] Cached ${this.nbaEvents.length} events`);
    }

    return this.nbaEvents;
  }

  async fetchNbaOddsForEvent(eventId) {
    const eventOdds = { bookmakers: {}, cachedAt: new Date() };

    // Fetch odds for multiple bookmakers at once
    const booksParam = NBA_BOOKMAKERS.join(',');
    const url = `${OPTIC_API_BASE}/fixtures/odds?fixture_id=${eventId}&sportsbook=${booksParam}`;
    const data = await this.fetchApi(url, `NBA odds ${eventId}`);

    if (data && data.data && data.data.length > 0) {
      const oddsData = data.data[0];

      // Process odds by sportsbook
      if (oddsData.odds) {
        for (const odd of oddsData.odds) {
          const book = odd.sportsbook;
          if (!eventOdds.bookmakers[book]) {
            eventOdds.bookmakers[book] = { markets: {} };
          }

          const market = odd.market;
          if (!eventOdds.bookmakers[book].markets[market]) {
            eventOdds.bookmakers[book].markets[market] = [];
          }

          eventOdds.bookmakers[book].markets[market].push({
            name: odd.name,
            price: odd.price,
            points: odd.points,
            is_main: odd.is_main
          });
        }
      }

      eventOdds.home = oddsData.home_team;
      eventOdds.away = oddsData.away_team;
      eventOdds.date = oddsData.start_date;
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

    // Fetch odds for ALL events (no rate limit)
    console.log(`[NBA] Refreshing odds for ${sortedEvents.length} events...`);

    for (const event of sortedEvents) {
      await this.fetchNbaOddsForEvent(event.id);
      await this.sleep(50); // Small delay to be nice to the server
    }

    this.lastNbaOddsUpdate = new Date();
  }

  // ==================== FOOTBALL FETCHING ====================

  async fetchFootballEvents(leagueSlug) {
    const url = `${OPTIC_API_BASE}/fixtures?sport=soccer&league=${leagueSlug}&status=unplayed`;
    const data = await this.fetchApi(url, `Football events for ${leagueSlug}`);

    if (data && data.data && Array.isArray(data.data)) {
      this.footballEvents[leagueSlug] = data.data.map(event => ({
        id: event.id,
        home: event.home_team,
        away: event.away_team,
        date: event.start_date,
        league: leagueSlug,
        status: event.status
      }));
      this.lastFootballEventsUpdate[leagueSlug] = new Date();
      console.log(`[Football] Cached ${this.footballEvents[leagueSlug].length} events for ${leagueSlug}`);
    }

    return this.footballEvents[leagueSlug] || [];
  }

  async fetchFootballOddsForEvent(eventId, bookmakers = FOOTBALL_BOOKMAKERS) {
    const eventOdds = { bookmakers: {}, cachedAt: new Date() };

    const booksParam = bookmakers.join(',');
    const url = `${OPTIC_API_BASE}/fixtures/odds?fixture_id=${eventId}&sportsbook=${booksParam}`;
    const data = await this.fetchApi(url, `Football odds ${eventId}`);

    if (data && data.data && data.data.length > 0) {
      const oddsData = data.data[0];

      if (oddsData.odds) {
        for (const odd of oddsData.odds) {
          const book = odd.sportsbook;
          if (!eventOdds.bookmakers[book]) {
            eventOdds.bookmakers[book] = { markets: {} };
          }

          const market = odd.market;
          if (!eventOdds.bookmakers[book].markets[market]) {
            eventOdds.bookmakers[book].markets[market] = [];
          }

          eventOdds.bookmakers[book].markets[market].push({
            name: odd.name,
            price: odd.price,
            points: odd.points,
            is_main: odd.is_main
          });
        }
      }

      eventOdds.home = oddsData.home_team;
      eventOdds.away = oddsData.away_team;
      eventOdds.date = oddsData.start_date;
    }

    this.footballOdds[eventId] = eventOdds;
    return eventOdds;
  }

  async refreshFootballOdds() {
    // Fetch events for all leagues
    for (const league of FOOTBALL_LEAGUES) {
      await this.fetchFootballEvents(league);
      await this.sleep(50);
    }

    // Collect all events across leagues
    const allEvents = [];
    for (const league of FOOTBALL_LEAGUES) {
      const events = this.footballEvents[league] || [];
      allEvents.push(...events.map(e => ({ ...e, league })));
    }

    // Sort by date
    const sortedEvents = allEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`[Football] Refreshing odds for ${sortedEvents.length} events...`);

    // Fetch odds for ALL events (no rate limit)
    for (const event of sortedEvents) {
      await this.fetchFootballOddsForEvent(event.id);
      await this.sleep(50); // Small delay
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
    const startApiCalls = this.apiCallCount;
    console.log(`\n========== STARTING FULL REFRESH ==========`);

    try {
      // Fetch NBA
      await this.fetchNbaEvents();
      await this.refreshNbaOdds();

      // Fetch Football
      await this.refreshFootballOdds();

      console.log(`========== REFRESH COMPLETE ==========`);
      console.log(`[Cache] API calls this refresh: ${this.apiCallCount - startApiCalls}`);
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
      apiCallCount: this.apiCallCount,
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

  // Fetch available leagues from OpticOdds (for debugging)
  async fetchAvailableLeagues(sport = 'soccer') {
    const url = `${OPTIC_API_BASE}/leagues/active?sport=${sport}`;
    const data = await this.fetchApi(url, `Available ${sport} leagues`);
    if (data && data.data) {
      return data.data;
    }
    return [];
  }
}

// Singleton instance
const cache = new OddsCache();

module.exports = cache;
