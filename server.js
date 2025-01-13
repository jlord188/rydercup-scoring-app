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
    ],
    nearestToPin: true|false,
    nearestToPinWinner: 'A'|'B'|null
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

    // NEW: We'll also store match.currentHoleIndex if you want 
    //      the server to track the "currently viewed" hole
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
        {
          dayNumber,
          format,
          matches: [ { playerA, playerB }, ... ],
          nearestToPin: true|false,
          nearestToPinWinner: null
        },
        ...
      ]
    }
  */
  const newTeams = teams || [];
  const newDays = days || [];

  // 1) Merge teams
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
        matches: newDay.matches,
        nearestToPin: newDay.nearestToPin || false,
        nearestToPinWinner: newDay.nearestToPinWinner || null
      });
    } else {
      // This day already exists
      const existingDay = tournamentData.days[existingDayIndex];

      // Update format
      existingDay.format = newDay.format;

      // Remove old matches that are not in newDay
      existingDay.matches = existingDay.matches.filter((oldMatch) => {
        return (
          findMatchingPairIndex(newDay.matches, oldMatch.playerA, oldMatch.playerB) !== -1
        );
      });

      // Add any new matches
      newDay.matches.forEach((m) => {
        const existingMatchIndex = findMatchingPairIndex(
          existingDay.matches,
          m.playerA,
          m.playerB
        );
        if (existingMatchIndex === -1) {
          existingDay.matches.push(m);
        }
      });

      existingDay.nearestToPin = newDay.nearestToPin || false;
      existingDay.nearestToPinWinner = newDay.nearestToPinWinner || null;
    }
  });

  // 3) Rebuild the flattened "matches" array from tournamentData.days
  rebuildMatches();

  // 4) Calculate totalPoints & pointsNeededToWin (including NTP 0.5 pts)
  let totalPoints = 0;
  tournamentData.days.forEach((day) => {
    const dayPoints = day.matches.length;  
    const ntpPoints = day.nearestToPin ? 0.5 : 0;  // +0.5 if nearestToPin
    totalPoints += (dayPoints + ntpPoints);
  });
  tournamentData.totalPoints = totalPoints;
  
  // Instead of Math.floor(...) + 1, do "half plus 0.5" 
  // Example: if totalPoints = 4 => 2 + 0.5 => 2.5 needed to win, not 3
  tournamentData.pointsNeededToWin = (totalPoints / 2) + 0.5;

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
        // Keep existing hole data, winner, etc.
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
          winner: null,
          // Optionally track currentHoleIndex server side:
          currentHoleIndex: 0
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

  // Send initial data
  socket.emit('initData', {
    cupName: tournamentData.cupName,
    teams: tournamentData.teams,
    matches: tournamentData.matches,
    days: tournamentData.days,
    pointsNeededToWin: tournamentData.pointsNeededToWin
  });

  // Hole scoring update (A/H/B)
  socket.on('holeUpdate', (update) => {
    const { matchIndex, holeIndex, result } = update;
    const match = tournamentData.matches[matchIndex];
    if (!match) return;

    match.holes[holeIndex] = result;
    recalcMatchState(match);

    // Broadcast updated match to all
    io.emit('matchDataUpdated', { matchIndex, match });
  });

  // ===========================
  // NEW: navHoleUpdate => sync hole navigation
  // ===========================
  socket.on('navHoleUpdate', (data) => {
    // data = { matchIndex, newHoleIndex }
    const { matchIndex, newHoleIndex } = data;
    
    // find the match
    const match = tournamentData.matches[matchIndex];
    if (!match) return;
  
    // store it on the server
    match.currentHoleIndex = newHoleIndex;
  
    // broadcast to all
    io.emit('navHoleUpdated', { matchIndex, newHoleIndex });
  });
  

  // Listen for nearestToPin update
  socket.on('ntpUpdate', (data) => {
    /*
      data: {
        dayNumber: 2,
        winner: 'A'|'B'|null
      }
    */
    const { dayNumber, winner } = data;
    const dayObj = tournamentData.days.find((d) => d.dayNumber === dayNumber);
    if (dayObj && dayObj.nearestToPin) {
      if (winner === 'A' || winner === 'B') {
        dayObj.nearestToPinWinner = winner;
      } else {
        dayObj.nearestToPinWinner = null;
      }
    }
    io.emit('ntpWinnerUpdated', {
      dayNumber,
      winner: dayObj?.nearestToPinWinner || null
    });
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

// Reset route
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

  io.emit('resetData');
  return res.json({ success: true, message: 'All data has been reset.' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
