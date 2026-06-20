// ============================================================
// client.js — 멀티플레이어 경매 게임 프론트엔드 로직
// Socket.io 클라이언트: 서버 이벤트 수신 및 UI 업데이트 담당
// ============================================================

// ── Socket.io 연결 초기화 ──────────────────────────────────
// 서버와 같은 origin으로 자동 연결됨 (개발: http://localhost:3000)
const socket = io();

// ── DOM 참조 ──────────────────────────────────────────────
const screens = {
  lobby:   document.getElementById("screen-lobby"),
  waiting: document.getElementById("screen-waiting"),
  auction: document.getElementById("screen-auction"),
  result:  document.getElementById("screen-result"),
};

// 로비
const inputName    = document.getElementById("input-name");
const inputRoomId  = document.getElementById("input-room-id");
const btnCreate    = document.getElementById("btn-create");
const btnJoin      = document.getElementById("btn-join");
const errorMsg     = document.getElementById("error-msg");

// 대기실
const waitingRoomId    = document.getElementById("waiting-room-id");
const waitingPlayers   = document.getElementById("waiting-players");
const btnStartGame     = document.getElementById("btn-start-game");
const waitingStatus    = document.getElementById("waiting-status");

// 경매장
const auctionRound     = document.getElementById("auction-round");
const auctionItemName  = document.getElementById("auction-item-name");
const auctionItemDesc  = document.getElementById("auction-item-desc");
const auctionBidAmount = document.getElementById("auction-bid-amount");
const auctionBidder    = document.getElementById("auction-bidder");
const timerDisplay     = document.getElementById("timer-display");
const playersList      = document.getElementById("players-list");
const inputBid         = document.getElementById("input-bid");
const btnBid           = document.getElementById("btn-bid");
const auctionLog       = document.getElementById("auction-log");
const roundResultBanner = document.getElementById("round-result-banner");

// 결과
const finalScoresList  = document.getElementById("final-scores-list");

// ── 클라이언트 상태 ────────────────────────────────────────
let mySocketId   = null;   // 내 소켓 ID (서버에서 할당)
let myName       = "";     // 내 닉네임
let myRoomId     = "";     // 참가 중인 방 ID
let isHost       = false;  // 방장 여부
let countdownInterval = null; // 클라이언트 카운트다운 타이머

// ── 유틸: 화면 전환 ────────────────────────────────────────
/**
 * 특정 화면만 보이도록 전환합니다.
 * @param {'lobby'|'waiting'|'auction'|'result'} name
 */
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
}

/** 경매 로그에 메시지 추가 (최신이 위로) */
function addLog(message, type = "info") {
  const li = document.createElement("li");
  li.className = `log-${type}`;
  li.textContent = message;
  // 맨 앞에 삽입 (최신 로그가 위에 표시)
  auctionLog.insertBefore(li, auctionLog.firstChild);

  // 최대 20개 유지
  while (auctionLog.children.length > 20) {
    auctionLog.removeChild(auctionLog.lastChild);
  }
}

/** 에러 메시지 표시 후 자동 소멸 */
function showError(message) {
  errorMsg.textContent = message;
  errorMsg.classList.remove("hidden");
  clearTimeout(showError._timer);
  showError._timer = setTimeout(() => {
    errorMsg.classList.add("hidden");
  }, 3000);
}

// ── 로비 버튼 이벤트 ──────────────────────────────────────

/** 방 만들기 버튼 */
btnCreate.addEventListener("click", () => {
  const name = inputName.value.trim();
  if (!name) { showError("닉네임을 입력해주세요."); return; }

  myName = name;
  isHost = true;
  socket.emit("create_room", { playerName: name });
});

/** 방 입장 버튼 */
btnJoin.addEventListener("click", () => {
  const name   = inputName.value.trim();
  const roomId = inputRoomId.value.trim().toUpperCase();

  if (!name)   { showError("닉네임을 입력해주세요."); return; }
  if (!roomId) { showError("방 코드를 입력해주세요."); return; }

  myName = name;
  isHost = false;
  socket.emit("join_room", { roomId, playerName: name });
});

// ── 대기실 이벤트 ─────────────────────────────────────────

/** 게임 시작 버튼 (방장만 표시됨) */
btnStartGame.addEventListener("click", () => {
  socket.emit("start_game");
});

// ── 경매장 입찰 이벤트 ────────────────────────────────────

/** 입찰 버튼 */
btnBid.addEventListener("click", () => {
  const amount = parseInt(inputBid.value, 10);
  if (isNaN(amount) || amount <= 0) {
    addLog("⚠️ 유효한 금액을 입력하세요.", "warn");
    return;
  }
  socket.emit("place_bid", { bidAmount: amount });
  inputBid.value = "";
});

/** Enter 키로도 입찰 가능 */
inputBid.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnBid.click();
});

// ── Socket.io 이벤트 수신 ─────────────────────────────────

/** 연결 완료 — 내 소켓 ID 저장 */
socket.on("connect", () => {
  mySocketId = socket.id;
  console.log("서버 연결 완료:", mySocketId);
});

/** 방 생성 완료 */
socket.on("room_created", ({ roomId }) => {
  myRoomId = roomId;
  waitingRoomId.textContent = roomId;
  btnStartGame.classList.remove("hidden"); // 방장만 시작 버튼 표시
  showScreen("waiting");
});

/** 방 입장 완료 */
socket.on("room_joined", ({ roomId }) => {
  myRoomId = roomId;
  waitingRoomId.textContent = roomId;
  btnStartGame.classList.add("hidden"); // 일반 플레이어는 시작 버튼 숨김
  showScreen("waiting");
});

/** 다른 플레이어 입장 알림 */
socket.on("player_joined", ({ playerName }) => {
  addLog(`✅ ${playerName}님이 입장했습니다.`, "join");
});

/** 플레이어 퇴장 알림 */
socket.on("player_left", ({ playerName }) => {
  addLog(`❌ ${playerName}님이 퇴장했습니다.`, "leave");
});

/**
 * 방 상태 전체 업데이트 — 가장 중요한 이벤트
 * 플레이어 목록, 소지금, 아이템, 현재 입찰가 등 모두 반영
 */
socket.on("room_update", (state) => {
  const { players, status, currentRound, totalRounds, currentItem,
          currentBid, currentBidderName } = state;

  // ── 대기실: 플레이어 목록 갱신 ────────────────────────
  waitingPlayers.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = `${p.isHost ? "👑 " : ""}${p.name}`;
    waitingPlayers.appendChild(li);
  });

  const playerCount = players.length;
  waitingStatus.textContent =
    `${playerCount}명 참가 중 (최소 3명 필요)`;
  btnStartGame.disabled = playerCount < 3 || !isHost;

  // ── 경매장: 플레이어 상태 패널 갱신 ──────────────────
  playersList.innerHTML = "";
  players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player-card" + (p.id === mySocketId ? " me" : "");
    div.innerHTML = `
      <span class="p-name">${p.isHost ? "👑" : "🧑"} ${p.name}${p.id === mySocketId ? " (나)" : ""}</span>
      <span class="p-gold">💰 ${p.gold.toLocaleString()}G</span>
      <span class="p-items">📦 ${p.items.length}개 보유</span>
    `;
    playersList.appendChild(div);
  });

  // ── 경매장: 현재 입찰 현황 갱신 ─────────────────────
  if (status === "auction") {
    auctionBidAmount.textContent = currentBid > 0
      ? `${currentBid.toLocaleString()}골드`
      : "아직 없음";
    auctionBidder.textContent = currentBidderName || "—";

    // 현재 최고 입찰자가 나 자신이면 입찰 버튼 비활성화
    const amILeading = players.find(
      (p) => p.name === currentBidderName && p.id === mySocketId
    );
    btnBid.disabled = !!amILeading;

    // 입찰 안내값 자동 설정 (현재 최고가 + 10)
    const myGold = players.find((p) => p.id === mySocketId)?.gold ?? 0;
    inputBid.placeholder = `최소 ${currentBid + 10}G (소지금: ${myGold}G)`;
  }
});

/** 게임 시작 예고 */
socket.on("game_starting", ({ message }) => {
  waitingStatus.textContent = message;
  btnStartGame.disabled = true;
});

/** 라운드 시작: 경매장 화면으로 전환 + 카운트다운 시작 */
socket.on("round_start", ({ round, totalRounds, itemName, itemDescription, duration }) => {
  showScreen("auction");
  roundResultBanner.classList.add("hidden");

  // 아이템 정보 표시
  auctionRound.textContent = `라운드 ${round} / ${totalRounds}`;
  auctionItemName.textContent = itemName;
  auctionItemDesc.textContent = itemDescription;
  auctionBidAmount.textContent = "아직 없음";
  auctionBidder.textContent = "—";

  // 이전 타이머 정리 후 새 카운트다운
  clearInterval(countdownInterval);
  let timeLeft = duration;
  timerDisplay.textContent = timeLeft;
  timerDisplay.className = "timer";

  countdownInterval = setInterval(() => {
    timeLeft--;
    timerDisplay.textContent = timeLeft;

    // 5초 이하면 빨간색 긴박감 연출
    if (timeLeft <= 5) {
      timerDisplay.classList.add("timer-urgent");
    }
    if (timeLeft <= 0) {
      clearInterval(countdownInterval);
    }
  }, 1000);

  addLog(`📣 ${round}라운드 시작! "${itemName}" 경매 시작`, "round");
  inputBid.value = "";
  btnBid.disabled = false;
});

/** 서버 타이머 동기화 (클라이언트 타이머와 간격이 생길 수 있어 서버 기준으로 보정) */
socket.on("timer_tick", ({ timeLeft }) => {
  timerDisplay.textContent = timeLeft;
});

/** 새로운 입찰 발생 */
socket.on("new_bid", ({ bidderName, bidAmount }) => {
  addLog(`💎 ${bidderName}: ${bidAmount.toLocaleString()}골드 입찰!`, "bid");
});

/** 라운드 결과 발표 */
socket.on("round_result", ({ winnerName, itemName, finalBid, message }) => {
  clearInterval(countdownInterval);

  // 배너로 결과 표시
  roundResultBanner.textContent = message;
  roundResultBanner.classList.remove("hidden");
  roundResultBanner.className = winnerName
    ? "result-banner result-sold"
    : "result-banner result-unsold";

  addLog(message, "result");
});

/** 서버에서 에러 메시지 수신 */
socket.on("error_msg", ({ message }) => {
  showError(message);
  addLog(`⚠️ ${message}`, "warn");
});

/** 게임 종료: 최종 순위 화면 전환 */
socket.on("game_over", ({ finalScores }) => {
  clearInterval(countdownInterval);
  showScreen("result");

  finalScoresList.innerHTML = "";

  const medals = ["🥇", "🥈", "🥉"];

  finalScores.forEach((player, index) => {
    const div = document.createElement("div");
    div.className = "score-card" + (player.name === myName ? " me" : "");

    // 아이템 목록 상세 렌더링
    const itemsHtml = player.items.length > 0
      ? player.items.map(
          (it) => `<span class="item-tag">${it.name} (${it.hiddenValue}G)</span>`
        ).join("")
      : "<span class='item-tag empty'>없음</span>";

    div.innerHTML = `
      <div class="rank">${medals[index] || `${index + 1}위`}</div>
      <div class="score-info">
        <strong>${player.name}${player.name === myName ? " (나)" : ""}</strong>
        <div class="score-detail">
          💰 남은 소지금: ${player.gold.toLocaleString()}G
          &nbsp;+&nbsp;
          📦 아이템 가치: ${player.itemValue.toLocaleString()}G
          &nbsp;=&nbsp;
          <strong>총 ${player.totalScore.toLocaleString()}G</strong>
        </div>
        <div class="score-items">${itemsHtml}</div>
      </div>
    `;
    finalScoresList.appendChild(div);
  });
});
