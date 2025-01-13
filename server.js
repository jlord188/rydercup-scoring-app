const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// ===========================
// In-Memory Data
// ===========================
let tournamentData = {
  cupName: 'My Ryder Cup', // default fallback
  teams: [],
  days: [],
  matches: [],
  totalPoints: 0,
  pointsNeededToWin: 0
};

/*
  Each element in days[] might look like:
  {
    dayNumber: 1,
    format: "Better Ball",
    matches: [
      { playerA: ["Alice","Bob"], playerB: ["Charlie","Dave"] },
      ...
    ]
  }

  In matches[], we store more detail:
  {
    dayNumber: 1,
    format: "Better Ball",
    playerA: [... or string],
    playerB: [... or string],
    holes: [null, null, ... up to 18], // 'A'|'B'|'H'
    holesUp: 0,
    holesPlayed: 0,
    winner: null|'A'|'B'|'draw'
  }
*/

// ===========================
// ROUTES
// ===========================

// Merge new admin data with existing data (instead of overwriting)
app.post('/api/setup', (req, res) => {
  const { cupName, teams, days } = req.body;

  // Save cupName if provided
  if (cupName) {
    tournamentData.cupName = cupName;
  }

  /*
    Expected req.body:
    {
      teams: [ { name, players }, { name, players } ],
      days: [
        { dayNumber, format, matches: [ { playerA, playerB }, ... ] },
        ...
      ]
    }
  */
  const newTeams = teams || [];
  const newDays = days || [];

  // 1) Merge teams (overwrite or keep as is, depending on your preference)
  //    For simplicity, we'll just overwrite the entire "teams" array if provided,
  //    because typically you won't be partially updating team rosters mid-tournament.
  if (newTeams.length > 0) {
    tournamentData.teams = newTeams;
  }

  // 2) Merge days
  newDays.forEach((newDay) => {
    const existingDayIndex = tournamentData.days.findIndex(
      (d) => d.dayNumber === newDay.dayNumber
    );

    if (existingDayIndex === -1) {
      // This day doesn't exist yet; add it
      tournamentData.days.push({
        dayNumber: newDay.dayNumber,
        format: newDay.format,
        matches: newDay.matches
      });
    } else {
      // This day already exists
      // 1) Update format
      tournamentData.days[existingDayIndex].format = newDay.format;

      // 2) Remove matches that are no longer in the newDay
      tournamentData.days[existingDayIndex].matches =
        tournamentData.days[existingDayIndex].matches.filter((oldMatch) => {
          return (
            findMatchingPairIndex(
              newDay.matches,
              oldMatch.playerA,
              oldMatch.playerB
            ) !== -1
          );
        });

      // 3) Add matches that are new
      newDay.matches.forEach((m) => {
        const existingMatchIndex = findMatchingPairIndex(
          tournamentData.days[existingDayIndex].matches,
          m.playerA,
          m.playerB
        );
        if (existingMatchIndex === -1) {
          // add new match
          tournamentData.days[existingDayIndex].matches.push(m);
        }
        // else if found, leave it (preserve hole data)
      });
    }
  });

  // 3) Rebuild the flattened "matches" array from tournamentData.days
  rebuildMatches();

  // 4) Calculate totalPoints & pointsNeededToWin
  let totalMatches = 0;
  tournamentData.days.forEach((day) => {
    totalMatches += day.matches.length;
  });
  tournamentData.totalPoints = totalMatches;
  tournamentData.pointsNeededToWin = Math.floor(totalMatches / 2) + 1;

  return res.json({
    success: true,
    totalPoints: tournamentData.totalPoints,
    pointsNeededToWin: tournamentData.pointsNeededToWin
  });
});

/** Helper to find an existing match in day.matches by comparing playerA & playerB */
function findMatchingPairIndex(existingMatches, playerA, playerB) {
  return existingMatches.findIndex((em) => {
    return samePlayers(em.playerA, playerA) && samePlayers(em.playerB, playerB);
  });
}

/** Compare A vs B, which could be string or array of strings */
function samePlayers(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => val === b[i]);
  } else if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }
  return false;
}

/** Rebuild tournamentData.matches from the days[] structure, preserving hole data if it already existed. */
function rebuildMatches() {
  const newMatches = [];
  tournamentData.days.forEach((day) => {
    day.matches.forEach((m) => {
      // see if we have an existing match with hole data
      const existingMatch = tournamentData.matches.find(
        (oldM) =>
          oldM.dayNumber === day.dayNumber &&
          samePlayers(oldM.playerA, m.playerA) &&
          samePlayers(oldM.playerB, m.playerB)
      );

      if (existingMatch) {
        // Keep existing hole data
        newMatches.push(existingMatch);
      } else {
        // Create new match entry
        newMatches.push({
          dayNumber: day.dayNumber,
          format: day.format,
          playerA: m.playerA,
          playerB: m.playerB,
          holes: Array.from({ length: 18 }, () => null),
          holesUp: 0,
          holesPlayed: 0,
          winner: null
        });
      }
    });
  });
  tournamentData.matches = newMatches;
}

// Return the entire data if needed
app.get('/api/tournament', (req, res) => {
  res.json(tournamentData);
});

// ===========================
// Socket.IO for Live Updates
// ===========================
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Send initial data, including cupName
  socket.emit('initData', {
    cupName: tournamentData.cupName,          // <--- Make sure we send cupName
    teams: tournamentData.teams,
    matches: tournamentData.matches,
    days: tournamentData.days,
    pointsNeededToWin: tournamentData.pointsNeededToWin
  });

  socket.on('holeUpdate', (update) => {
    const { matchIndex, holeIndex, result } = update;
    const match = tournamentData.matches[matchIndex];
    if (!match) return;

    // Update the hole
    match.holes[holeIndex] = result;
    recalcMatchState(match);

    // Broadcast updated match to all
    io.emit('matchDataUpdated', { matchIndex, match });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Helper to recalc "holesUp", "winner", etc.
function recalcMatchState(match) {
  let aWins = 0;
  let bWins = 0;
  let holesPlayed = 0;

  match.holes.forEach((hole) => {
    if (hole === 'A') {
      aWins++;
      holesPlayed++;
    } else if (hole === 'B') {
      bWins++;
      holesPlayed++;
    } else if (hole === 'H') {
      holesPlayed++;
    }
  });

  match.holesUp = aWins - bWins;
  match.holesPlayed = holesPlayed;

  const holesRemaining = 18 - holesPlayed;
  const absUp = Math.abs(match.holesUp);

  // Concluded early?
  if (absUp > holesRemaining) {
    match.winner = match.holesUp > 0 ? 'A' : 'B';
  } else if (holesPlayed === 18) {
    // All holes played
    if (match.holesUp > 0) {
      match.winner = 'A';
    } else if (match.holesUp < 0) {
      match.winner = 'B';
    } else {
      match.winner = 'draw';
    }
  } else {
    match.winner = null; // Still in progress
  }
}

app.post('/api/reset', (req, res) => {
    // Wipe out data
    tournamentData = {
      cupName: '',
      teams: [],
      days: [],
      matches: [],
      totalPoints: 0,
      pointsNeededToWin: 0
    };
  
    // If you're using Socket.IO, you can also broadcast a "reset" event
    // to clients so they reload or do something special, if desired:
    io.emit('resetData');
  
    return res.json({ success: true, message: 'All data has been reset.' });
  });
  
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
