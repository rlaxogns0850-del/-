// ============================================================
// server.js — 멀티플레이어 경매 게임 백엔드
// 기술 스택: Node.js + Express + Socket.io
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }, // 개발 중에는 모든 출처 허용
});

// ── 정적 파일 서빙 (public/ 폴더) ──────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── 게임 상수 ──────────────────────────────────────────────
const STARTING_GOLD = 1000;   // 초기 소지금 (골드)
const BID_STEP = 10;          // 최소 입찰 단위
const ROUND_TIME = 15;        // 라운드당 경매 시간 (초)
const TOTAL_ROUNDS = 5;       // 총 라운드 수
const MIN_PLAYERS = 3;        // 게임 시작 최소 인원

// ── 판타지 경매 아이템 풀 ──────────────────────────────────
// hiddenValue: 게임 종료 후 공개되는 '진짜 가치'
// description: 경매장에서 보이는 모호한 설명
const ITEM_POOL = [
  { name: "봉인된 마법서",       description: "내용을 알 수 없는 낡은 책. 어딘가에서 속삭이는 소리가 난다.",         hiddenValue: 350 },
  { name: "용의 비늘 조각",      description: "찬란하게 빛나는 금빛 비늘. 단단함이 느껴진다.",                     hiddenValue: 420 },
  { name: "달빛 포션",          description: "보름달 아래서만 빛나는 푸른 액체. 효과 불명.",                      hiddenValue: 180 },
  { name: "고대 유물 파편",      description: "문명 이전의 것으로 보이는 돌 조각. 기묘한 문양이 새겨져 있다.",       hiddenValue: 500 },
  { name: "요정의 날개",         description: "아직도 미세하게 떨리는 투명한 날개.",                              hiddenValue: 290 },
  { name: "저주받은 반지",       description: "손가락에 끼우면 빠지지 않는다는 소문이 있다.",                       hiddenValue: 60  },
  { name: "시간의 모래시계",     description: "모래가 위에서 아래로, 때로는 반대로 흐른다.",                       hiddenValue: 610 },
  { name: "혼돈의 수정구",       description: "안을 들여다보면 다른 세계가 보인다고 한다.",                        hiddenValue: 380 },
];

// ── 서버 상태 ──────────────────────────────────────────────
// rooms: { [roomId]: RoomState }
const rooms = {};

/**
 * RoomState 구조:
 * {
 *   id: string,
 *   players: { [socketId]: PlayerState },
 *   status: 'waiting' | 'auction' | 'finished',
 *   currentRound: number,           // 1-based
 *   currentItem: AuctionItem | null,
 *   currentBid: number,
 *   currentBidder: string | null,   // socketId
 *   roundTimer: NodeJS.Timeout | null,
 *   roundItems: AuctionItem[],      // 이번 게임에서 사용할 아이템 목록
 * }
 *
 * PlayerState:
 * {
 *   id: string,       // socketId
 *   name: string,
 *   gold: number,
 *   items: AuctionItem[],
 * }
 */

// ── 유틸리티 함수들 ────────────────────────────────────────

/** 배열을 무작위로 섞어 앞에서 n개 반환 (Fisher-Yates) */
function pickRandomItems(pool, n) {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

/** 방 ID 생성 (간단한 6자리 대문자) */
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/** 특정 방의 모든 플레이어에게 현재 상태 브로드캐스트 */
function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("room_update", {
    players: Object.values(room.players),
    status: room.status,
    currentRound: room.currentRound,
    totalRounds: TOTAL_ROUNDS,
    currentItem: room.currentItem
      ? {
          name: room.currentItem.name,
          description: room.currentItem.description,
          // hiddenValue는 게임 중에는 전송하지 않음 (보안)
        }
      : null,
    currentBid: room.currentBid,
    currentBidderName: room.currentBidder
      ? room.players[room.currentBidder]?.name
      : null,
  });
}

// ── 경매 라운드 로직 ───────────────────────────────────────

/**
 * 새 라운드를 시작합니다.
 * 아이템을 뽑고, 카운트다운 타이머를 시작합니다.
 */
function startRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // 다음 아이템 꺼내기
  const item = room.roundItems[room.currentRound - 1];
  room.currentItem = item;
  room.currentBid = 0;
  room.currentBidder = null;

  room.status = "auction";
  broadcastRoomState(roomId);

  // 클라이언트에 라운드 시작 신호 (카운트다운용)
  io.to(roomId).emit("round_start", {
    round: room.currentRound,
    totalRounds: TOTAL_ROUNDS,
    itemName: item.name,
    itemDescription: item.description,
    duration: ROUND_TIME,
  });

  // 서버-사이드 카운트다운
  let timeLeft = ROUND_TIME;
  const tick = () => {
    timeLeft--;
    io.to(roomId).emit("timer_tick", { timeLeft });

    if (timeLeft <= 0) {
      endRound(roomId);
    } else {
      room.roundTimer = setTimeout(tick, 1000);
    }
  };
  room.roundTimer = setTimeout(tick, 1000);
}

/**
 * 라운드 종료: 낙찰 처리 및 다음 라운드 진행 결정
 */
function endRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  clearTimeout(room.roundTimer);
  room.roundTimer = null;

  const winner = room.currentBidder ? room.players[room.currentBidder] : null;

  if (winner && room.currentBid > 0) {
    // 낙찰: 소지금 차감 + 아이템 지급
    winner.gold -= room.currentBid;
    winner.items.push({ ...room.currentItem });

    io.to(roomId).emit("round_result", {
      winnerName: winner.name,
      itemName: room.currentItem.name,
      finalBid: room.currentBid,
      message: `🏆 ${winner.name}님이 ${room.currentBid}골드에 낙찰받았습니다!`,
    });
  } else {
    // 유찰 (아무도 입찰 안 함)
    io.to(roomId).emit("round_result", {
      winnerName: null,
      itemName: room.currentItem.name,
      finalBid: 0,
      message: `🚫 유찰 — 아무도 입찰하지 않았습니다.`,
    });
  }

  broadcastRoomState(roomId);

  // 다음 라운드 or 게임 종료
  if (room.currentRound >= TOTAL_ROUNDS) {
    // 3초 후 게임 종료 처리
    setTimeout(() => endGame(roomId), 3000);
  } else {
    room.currentRound++;
    // 3초 딜레이 후 다음 라운드
    setTimeout(() => startRound(roomId), 3000);
  }
}

/**
 * 게임 종료: 숨겨진 가치 공개 + 최종 순위 계산
 */
function endGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = "finished";

  // 각 플레이어의 최종 점수 계산
  // 점수 = 남은 소지금 + 보유 아이템의 hiddenValue 합산
  const finalScores = Object.values(room.players)
    .map((player) => {
      const itemValue = player.items.reduce(
        (sum, item) => sum + (item.hiddenValue || 0),
        0
      );
      return {
        name: player.name,
        gold: player.gold,
        itemValue,
        totalScore: player.gold + itemValue,
        items: player.items.map((it) => ({
          name: it.name,
          hiddenValue: it.hiddenValue, // 이제 공개
        })),
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore); // 내림차순 정렬

  io.to(roomId).emit("game_over", { finalScores });

  // 10초 후 방 정리 (메모리 누수 방지)
  setTimeout(() => {
    delete rooms[roomId];
  }, 60000);
}

// ── Socket.io 이벤트 핸들러 ────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[연결] ${socket.id}`);

  // ── 방 만들기 ────────────────────────────────────────────
  socket.on("create_room", ({ playerName }) => {
    const roomId = generateRoomId();

    rooms[roomId] = {
      id: roomId,
      players: {},
      status: "waiting",
      currentRound: 1,
      currentItem: null,
      currentBid: 0,
      currentBidder: null,
      roundTimer: null,
      roundItems: [],
    };

    // 방장 플레이어 등록
    rooms[roomId].players[socket.id] = {
      id: socket.id,
      name: playerName,
      gold: STARTING_GOLD,
      items: [],
      isHost: true,
    };

    socket.join(roomId);
    socket.data.roomId = roomId; // 소켓에 방 ID 저장 (disconnect 처리용)

    socket.emit("room_created", { roomId });
    broadcastRoomState(roomId);

    console.log(`[방 생성] ${roomId} by ${playerName}`);
  });

  // ── 방 입장 ──────────────────────────────────────────────
  socket.on("join_room", ({ roomId, playerName }) => {
    const room = rooms[roomId];

    // 유효성 검사
    if (!room) {
      socket.emit("error_msg", { message: "존재하지 않는 방입니다." });
      return;
    }
    if (room.status !== "waiting") {
      socket.emit("error_msg", { message: "이미 게임이 진행 중인 방입니다." });
      return;
    }

    // 플레이어 등록
    room.players[socket.id] = {
      id: socket.id,
      name: playerName,
      gold: STARTING_GOLD,
      items: [],
      isHost: false,
    };

    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit("room_joined", { roomId });
    broadcastRoomState(roomId);

    // 새 플레이어 입장 알림
    io.to(roomId).emit("player_joined", { playerName });
    console.log(`[입장] ${playerName} → 방 ${roomId}`);
  });

  // ── 게임 시작 (방장만 가능) ──────────────────────────────
  socket.on("start_game", () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player?.isHost) {
      socket.emit("error_msg", { message: "방장만 게임을 시작할 수 있습니다." });
      return;
    }

    const playerCount = Object.keys(room.players).length;
    if (playerCount < MIN_PLAYERS) {
      socket.emit("error_msg", {
        message: `게임 시작에는 최소 ${MIN_PLAYERS}명이 필요합니다. (현재 ${playerCount}명)`,
      });
      return;
    }

    // 이번 게임에서 사용할 아이템 무작위 선정
    room.roundItems = pickRandomItems(ITEM_POOL, TOTAL_ROUNDS);
    room.currentRound = 1;

    io.to(roomId).emit("game_starting", { message: "게임이 곧 시작됩니다..." });

    // 2초 후 첫 라운드 시작
    setTimeout(() => startRound(roomId), 2000);
    console.log(`[게임 시작] 방 ${roomId}`);
  });

  // ── 입찰 ─────────────────────────────────────────────────
  socket.on("place_bid", ({ bidAmount }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== "auction") return;

    const player = room.players[socket.id];
    if (!player) return;

    // 유효성 검사
    const minRequired = room.currentBid + BID_STEP;

    if (bidAmount < minRequired) {
      socket.emit("error_msg", {
        message: `최소 ${minRequired}골드 이상 입찰해야 합니다.`,
      });
      return;
    }
    if (bidAmount > player.gold) {
      socket.emit("error_msg", { message: "소지금이 부족합니다." });
      return;
    }
    if (socket.id === room.currentBidder) {
      socket.emit("error_msg", { message: "이미 최고 입찰자입니다." });
      return;
    }

    // 입찰 성공: 서버 상태 업데이트
    room.currentBid = bidAmount;
    room.currentBidder = socket.id;

    // 전체 플레이어에게 새 입찰가 알림
    io.to(roomId).emit("new_bid", {
      bidderName: player.name,
      bidAmount,
    });

    broadcastRoomState(roomId);
    console.log(`[입찰] ${player.name}: ${bidAmount}골드 (방 ${roomId})`);
  });

  // ── 연결 해제 처리 ────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players[socket.id];
    const playerName = player?.name || "알 수 없음";

    delete room.players[socket.id];

    io.to(roomId).emit("player_left", { playerName });
    console.log(`[퇴장] ${playerName} (방 ${roomId})`);

    // 방에 아무도 없으면 방 삭제
    if (Object.keys(room.players).length === 0) {
      clearTimeout(room.roundTimer);
      delete rooms[roomId];
      console.log(`[방 삭제] ${roomId} (빈 방)`);
      return;
    }

    // 게임 중 플레이어 이탈 시 상태 갱신
    if (room.status === "auction" || room.status === "waiting") {
      broadcastRoomState(roomId);
    }
  });
});

// ── 서버 시작 ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});
