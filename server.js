/**
 * SERVER.JS - Bot de Trading Deriv via Terminal com 6 Indicadores
 * BOT RODA 24H MESMO COM SITE FECHADO - SEM FIREBASE
 * 
 * Instalação:
 * 1. Crie uma pasta.
 * 2. Rode: npm init -y
 * 3. Rode: npm install ws readline
 * 4. Rode: node server.js
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- CONFIGURAÇÃO LOCAL (SEM FIREBASE) ---
const DATA_FILE = path.join(__dirname, 'users.json');

// Interface para input do terminal
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Carregar dados de usuários
function loadUsersData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('⚠️ Erro ao carregar dados locais, usando padrão vazio.');
    }
    return {};
}

// Salvar dados de usuários
function saveUsersData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let usersData = loadUsersData();

// Armazena as sessões ativas dos usuários
const activeSessions = {};

console.log("🤖 Bot de Trading Deriv - Modo Terminal");
console.log("📊 6 Indicadores: RSI, MACD, SMA, EMA, Bollinger Bands, Estocástico");
console.log("========================================");

// Menu principal
function showMainMenu() {
    console.log("\n=== MENU PRINCIPAL ===");
    console.log("1. Login");
    console.log("2. Criar nova conta");
    console.log("3. Sair");
    rl.question("Escolha uma opção: ", handleMenuChoice);
}

function handleMenuChoice(choice) {
    switch(choice.trim()) {
        case '1':
            login();
            break;
        case '2':
            register();
            break;
        case '3':
            console.log("👋 Até logo!");
            process.exit(0);
        default:
            console.log("❌ Opção inválida!");
            showMainMenu();
    }
}

function login() {
    rl.question("Usuário: ", (user) => {
        rl.question("Senha: ", (pass) => {
            if(!usersData[user] || usersData[user].pass !== pass) {
                console.log("❌ Usuário ou senha inválidos!");
                return showMainMenu();
            }
            
            const userData = usersData[user];
            console.log(`✅ Login bem-sucedido! Bem-vindo, ${user}`);
            showUserMenu(user, userData.userId);
        });
    });
}

function register() {
    rl.question("Novo usuário: ", (user) => {
        if(usersData[user]) {
            console.log("❌ Usuário já existe!");
            return showMainMenu();
        }
        
        rl.question("Senha: ", (pass) => {
            rl.question("Confirmar senha: ", (passConfirm) => {
                if(pass !== passConfirm) {
                    console.log("❌ Senhas não conferem!");
                    return showMainMenu();
                }
                
                const userId = 'user_' + Date.now();
                usersData[user] = { 
                    userId, 
                    pass, 
                    stats: { dailyProfit: 0, wins: 0, losses: 0, tradesToday: 0, balance: 0 },
                    logs: [], 
                    config: {},
                    isRunning: false
                };
                saveUsersData(usersData);
                
                console.log(`✅ Conta criada com sucesso!`);
                showMainMenu();
            });
        });
    });
}

function showUserMenu(userName, userId) {
    console.log(`\n=== MENU DO USUÁRIO: ${userName} ===`);
    console.log("1. Iniciar Bot");
    console.log("2. Parar Bot");
    console.log("3. Ver Estatísticas");
    console.log("4. Ver Logs");
    console.log("5. Configurar Parâmetros");
    console.log("6. Ver Indicadores Atuais");
    console.log("7. Logout");
    
    rl.question("Escolha uma opção: ", (choice) => {
        switch(choice.trim()) {
            case '1':
                configureAndStartBot(userName, userId);
                break;
            case '2':
                stopBotSession(userId);
                showUserMenu(userName, userId);
                break;
            case '3':
                showStats(userName, userId);
                break;
            case '4':
                showLogs(userName);
                break;
            case '5':
                configureBot(userName, userId);
                break;
            case '6':
                showIndicators(userName, userId);
                break;
            case '7':
                console.log("👋 Logout realizado!");
                showMainMenu();
                break;
            default:
                console.log("❌ Opção inválida!");
                showUserMenu(userName, userId);
        }
    });
}

function showIndicators(userName, userId) {
    const session = activeSessions[userId];
    
    if(!session || !session.state.priceHistory || session.state.priceHistory.length < 50) {
        console.log("\n📊 Aguardando dados suficientes para calcular indicadores...");
        console.log("O bot precisa coletar pelo menos 50 ticks de preço.");
        rl.question("\nPressione ENTER para voltar...", () => {
            showUserMenu(userName, userId);
        });
        return;
    }
    
    const prices = session.state.priceHistory;
    const currentPrice = session.state.currentPrice;
    
    // Calcular todos os 6 indicadores
    const rsi = calculateRSI(prices, 14);
    const macd = calculateMACD(prices);
    const sma20 = calculateSMA(prices, 20);
    const sma50 = calculateSMA(prices, 50);
    const ema20 = calculateEMA(prices, 20);
    const bollinger = calculateBollingerBands(prices, 20);
    const stochastic = calculateStochastic(prices, 14);
    
    console.log("\n=== 📊 INDICADORES ATUAIS ===");
    console.log(`Preço Atual: $${currentPrice.toFixed(5)}`);
    console.log("\n1️⃣  RSI (14):");
    console.log(`   Valor: ${rsi.toFixed(2)}`);
    console.log(`   Status: ${rsi > 70 ? 'Sobrevendido 📈' : rsi < 30 ? 'Sobrevendido 📉' : 'Neutro ⚖️'}`);
    
    console.log("\n2️⃣  MACD:");
    console.log(`   MACD Line: ${macd.macd.toFixed(5)}`);
    console.log(`   Signal Line: ${macd.signal.toFixed(5)}`);
    console.log(`   Histograma: ${macd.histogram.toFixed(5)}`);
    console.log(`   Status: ${macd.histogram > 0 ? 'Momentum Positivo ⬆️' : 'Momentum Negativo ⬇️'}`);
    
    console.log("\n3️⃣  Médias Móveis:");
    console.log(`   SMA 20: $${sma20 ? sma20.toFixed(5) : 'N/A'}`);
    console.log(`   SMA 50: $${sma50 ? sma50.toFixed(5) : 'N/A'}`);
    console.log(`   EMA 20: $${ema20 ? ema20.toFixed(5) : 'N/A'}`);
    console.log(`   Preço vs SMA20: ${currentPrice > sma20 ? 'Acima ⬆️' : 'Abaixo ⬇️'}`);
    
    console.log("\n4️⃣  Bollinger Bands (20,2):");
    if(bollinger) {
        console.log(`   Superior: $${bollinger.upper.toFixed(5)}`);
        console.log(`   Média: $${bollinger.middle.toFixed(5)}`);
        console.log(`   Inferior: $${bollinger.lower.toFixed(5)}`);
        console.log(`   Largura: $${(bollinger.upper - bollinger.lower).toFixed(5)}`);
        console.log(`   Posição: ${currentPrice <= bollinger.lower ? 'Na banda inferior' : currentPrice >= bollinger.upper ? 'Na banda superior' : 'Dentro das bandas'}`);
    }
    
    console.log("\n5️⃣  Estocástico (14,3,3):");
    console.log(`   %K: ${stochastic.k ? stochastic.k.toFixed(2) : 'N/A'}`);
    console.log(`   %D: ${stochastic.d ? stochastic.d.toFixed(2) : 'N/A'}`);
    console.log(`   Status: ${stochastic.k > 80 ? 'Sobrevendido 📈' : stochastic.k < 20 ? 'Sobrevendido 📉' : 'Neutro ⚖️'}`);
    
    console.log("\n6️⃣  Análise Combinada:");
    let buySignals = 0;
    let sellSignals = 0;
    
    if(rsi < 30) buySignals++;
    if(rsi > 70) sellSignals++;
    if(macd.histogram > 0) buySignals++;
    if(macd.histogram < 0) sellSignals++;
    if(currentPrice > sma20) buySignals++;
    if(currentPrice < sma20) sellSignals++;
    if(bollinger && currentPrice <= bollinger.lower) buySignals++;
    if(bollinger && currentPrice >= bollinger.upper) sellSignals++;
    if(stochastic.k < 20) buySignals++;
    if(stochastic.k > 80) sellSignals++;
    
    console.log(`   Força COMPRA: ${buySignals}/5 📈`);
    console.log(`   Força VENDA: ${sellSignals}/5 📉`);
    console.log(`   Recomendação: ${buySignals > sellSignals ? 'CALL ✅' : sellSignals > buySignals ? 'PUT ✅' : 'NEUTRO ⚖️'}`);
    
    rl.question("\nPressione ENTER para voltar...", () => {
        showUserMenu(userName, userId);
    });
}

function configureBot(userName, userId) {
    console.log("\n=== CONFIGURAÇÃO DO BOT ===");
    const currentConfig = usersData[userName].config || {};
    
    rl.question(`Token da API Deriv [${currentConfig.token || ''}]: `, (token) => {
        if(token) currentConfig.token = token;
        
        rl.question(`Stake em USD [${currentConfig.stake || '0.35'}]: `, (stake) => {
            if(stake) currentConfig.stake = parseFloat(stake);
            
            rl.question(`Meta de lucro USD [${currentConfig.takeProfit || '5.00'}]: `, (tp) => {
                if(tp) currentConfig.takeProfit = parseFloat(tp);
                
                rl.question(`Stop Loss USD [${currentConfig.stopLoss || '-100'}]: `, (sl) => {
                    if(sl) currentConfig.stopLoss = parseFloat(sl);
                    
                    rl.question(`Nível de Segurança (10-100%) [${currentConfig.securityLevel || '50'}]: `, (sec) => {
                        if(sec) currentConfig.securityLevel = parseInt(sec);
                        
                        rl.question(`Nível de Risco (10-100%) [${currentConfig.riskLevel || '50'}]: `, (risk) => {
                            if(risk) currentConfig.riskLevel = parseInt(risk);
                            
                            rl.question(`Score mínimo para executar (0-100%) [${currentConfig.minScore || '25'}]: `, (score) => {
                                if(score) currentConfig.minScore = parseInt(score);
                                
                                rl.question(`Símbolo do ativo [${currentConfig.symbol || 'R_100'}]: `, (symbol) => {
                                    if(symbol) currentConfig.symbol = symbol;
                                    
                                    usersData[userName].config = currentConfig;
                                    saveUsersData(usersData);
                                    console.log("✅ Configurações salvas!");
                                    showUserMenu(userName, userId);
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

function configureAndStartBot(userName, userId) {
    const config = usersData[userName].config || {};
    
    if(!config.token) {
        console.log("❌ Configure o token da API primeiro!");
        return configureBot(userName, userId);
    }
    
    console.log(`\n🚀 Iniciando bot para ${userName}...`);
    usersData[userName].isRunning = true;
    saveUsersData(usersData);
    
    startBotSession(userId, config.token, config);
    showUserMenu(userName, userId);
}

function showStats(userName, userId) {
    const stats = usersData[userName].stats || { 
        dailyProfit: 0, wins: 0, losses: 0, tradesToday: 0, balance: 0 
    };
    const session = activeSessions[userId];
    
    console.log("\n=== ESTATÍSTICAS ===");
    console.log(`Saldo: $${(session ? session.state.balance : stats.balance || 0).toFixed(2)}`);
    console.log(`Lucro Hoje: $${(session ? session.state.dailyProfit : stats.dailyProfit || 0).toFixed(2)}`);
    console.log(`Trades Hoje: ${session ? session.state.tradesToday : stats.tradesToday || 0}`);
    console.log(`Wins: ${session ? session.state.wins : stats.wins || 0}`);
    console.log(`Losses: ${session ? session.state.losses : stats.losses || 0}`);
    
    const total = (session ? session.state.wins + session.state.losses : stats.wins + stats.losses) || 0;
    const rate = total > 0 ? Math.round(((session ? session.state.wins : stats.wins) / total) * 100) : 0;
    console.log(`Assertividade: ${rate}%`);
    
    if(session && session.state.consecutiveLosses > 0) {
        console.log(`Perdas consecutivas: ${session.state.consecutiveLosses}`);
    }
    
    rl.question("\nPressione ENTER para voltar...", () => {
        showUserMenu(userName, userId);
    });
}

function showLogs(userName) {
    console.log("\n=== LOGS RECENTES ===");
    const logs = usersData[userName].logs || [];
    
    if(logs.length === 0) {
        console.log("Nenhum log disponível.");
    } else {
        logs.slice(-20).forEach(log => {
            const icon = log.type === 'success' ? '✅' : log.type === 'error' ? '❌' : '📝';
            console.log(`${icon} [${log.time}] ${log.msg}`);
        });
    }
    
    rl.question("\nPressione ENTER para voltar...", () => {
        showUserMenu(userName, userId);
    });
}

// --- LÓGICA DO BOT (SESSÃO INDIVIDUAL) ---
function startBotSession(userId, token, config) {
    const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

    const userName = Object.keys(usersData).find(u => usersData[u].userId === userId);
    if (!userName) {
        console.error(`❌ [${userId}] Usuário não encontrado!`);
        return;
    }

    const savedStats = (usersData[userName] && usersData[userName].stats) ? usersData[userName].stats : {};

    const securityLevel = config.securityLevel || 50;
    const riskLevel = config.riskLevel || 50;
    
    const rsiOffset = ((securityLevel - 10) / 90) * 15;
    const riskMultiplier = riskLevel / 50;
    
    const botConfig = {
        ...config,
        rsiLow: 30 - rsiOffset,
        rsiHigh: 70 + rsiOffset,
        stake: Math.max(0.35, (config.stake || 0.35) * riskMultiplier),
        maxTrades: Math.floor(50 + (riskLevel - 10) * 0.5),
        stopLoss: config.stopLoss || -100,
        takeProfit: config.takeProfit || 5.00,
        minScore: config.minScore || 25,
        symbol: config.symbol || 'R_100'
    };

    console.log(`\n[${userName}] Bot configurado:`);
    console.log(`   Segurança: ${securityLevel}% | Risco: ${riskLevel}%`);
    console.log(`   Stake: $${botConfig.stake.toFixed(2)} | Max Trades: ${botConfig.maxTrades}`);
    console.log(`   RSI: ${botConfig.rsiLow.toFixed(1)}/${botConfig.rsiHigh.toFixed(1)}`);
    console.log(`   Score mínimo: ${botConfig.minScore}%`);
    
    if (savedStats.lastUpdate) {
        const lastDate = new Date(savedStats.lastUpdate);
        const today = new Date();
        
        if (lastDate.getDate() !== today.getDate() || 
            lastDate.getMonth() !== today.getMonth() ||
            lastDate.getFullYear() !== today.getFullYear()) {
            savedStats.dailyProfit = 0;
            savedStats.tradesToday = 0;
            savedStats.wins = 0;
            savedStats.losses = 0;
            savedStats.consecutiveLosses = 0;
            console.log(`[${userName}] Novo dia detectado, resetando estatísticas.`);
        }
    }

    const session = {
        userId: userId,
        userName: userName,
        ws: ws,
        config: botConfig,
        openContract: false,
        state: {
            dailyProfit: savedStats.dailyProfit || 0,
            wins: savedStats.wins || 0,
            losses: savedStats.losses || 0,
            tradesToday: savedStats.tradesToday || 0,
            consecutiveLosses: savedStats.consecutiveLosses || 0,
            priceHistory: [],
            currentPrice: 0,
            balance: savedStats.balance || 0,
            simulation: {
                active: false,
                direction: null,
                startTime: 0,
                priceData: [],
                predictionScore: 0,
                priceAtStart: 0,
                timer: null
            }
        },
        strategyTimer: null
    };

    activeSessions[userId] = session;

    ws.on('open', () => {
        console.log(`[${userName}] 🔗 Conectado ao servidor Deriv!`);
        logToLocal(userName, 'Conectado ao Deriv', 'info');
        ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        if (data.error) {
            console.error(`[${userName}] Erro:`, data.error.message || data.error);
            logToLocal(userName, `Erro API: ${data.error.message || 'Erro desconhecido'}`, 'error');

            if (data.error.code === 'MarketIsClosed') {
                logToLocal(userName, 'Mercado Fechado! Parando bot.', 'error');
                stopBotSession(userId);
            }
            return;
        }

        if (data.msg_type === 'authorize') {
            console.log(`[${userName}] ✅ Autorizado.`);
            logToLocal(userName, 'Bot rodando 24h', 'success');
            ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
            ws.send(JSON.stringify({ ticks: botConfig.symbol, subscribe: 1 }));
        }

        if (data.msg_type === 'proposal') {
            if (data.proposal) {
                ws.send(JSON.stringify({
                    buy: data.proposal.id,
                    price: data.proposal.ask_price
                }));
            }
        }

        if (data.msg_type === 'buy') {
            console.log(`[${userName}] ✅ ORDEM EXECUTADA! ID: ${data.buy.contract_id}`);
            logToLocal(userName, `Ordem executada! ID: ${data.buy.contract_id}`, 'info');
            ws.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: data.buy.contract_id,
                subscribe: 1
            }));
        }

        if (data.msg_type === 'balance') {
            session.state.balance = data.balance.balance;
            if (usersData[userName]) {
                usersData[userName].stats = usersData[userName].stats || {};
                usersData[userName].stats.balance = session.state.balance;
                saveUsersData(usersData);
            }
        }

        if (data.msg_type === 'tick') {
            session.state.currentPrice = data.tick.quote;
            session.state.priceHistory.push(data.tick.quote);
            if (session.state.priceHistory.length > 200) session.state.priceHistory.shift();
        }

        if (data.msg_type === 'proposal_open_contract') {
            const contract = data.proposal_open_contract;
            if (contract.is_sold) {
                const profit = contract.profit;
                session.state.dailyProfit += profit;
                session.openContract = false;
                session.state.tradesToday++;
                
                if (profit > 0) {
                    session.state.wins++;
                    session.state.consecutiveLosses = 0;
                    console.log(`[${userName}] ✅ GANHOU! +$${profit.toFixed(2)} (Total: $${session.state.dailyProfit.toFixed(2)})`);
                } else {
                    session.state.losses++;
                    session.state.consecutiveLosses++;
                    console.log(`[${userName}] ❌ PERDEU! $${profit.toFixed(2)} (Total: $${session.state.dailyProfit.toFixed(2)})`);
                }

                updateLocalStatsFile(userName, session.state);
                logToLocal(userName, `Trade finalizado: $${profit.toFixed(2)}`, profit > 0 ? 'success' : 'error');
            }
        }
    });

    ws.on('close', () => {
        console.log(`[${userName}] Desconectado.`);
        if (activeSessions[userId]) {
            clearInterval(session.strategyTimer);
            if (session.state.simulation.timer) clearInterval(session.state.simulation.timer);
            setTimeout(() => startBotSession(userId, token, botConfig), 5000);
        }
    });

    // --- LOOP DA ESTRATÉGIA COM 6 INDICADORES ---
    session.strategyTimer = setInterval(() => {
        const state = session.state;
        const conf = session.config;

        if (session.openContract || state.simulation.active) return;
        
        if (state.tradesToday >= conf.maxTrades) return;
        if (state.dailyProfit >= conf.takeProfit) {
            logToLocal(userName, 'Meta batida! Parando bot.', 'success');
            stopBotSession(userId);
            return;
        }
        if (state.dailyProfit <= conf.stopLoss) {
            logToLocal(userName, 'Stop Loss atingido! O bot será pausado até o próximo dia.', 'error');
            if (usersData[userName]) {
                if (!usersData[userName].stats) usersData[userName].stats = {};
                usersData[userName].stats.stopLossHitDate = new Date().toISOString().split('T')[0];
            }
            stopBotSession(userId);
            return;
        }
        if (state.consecutiveLosses >= 5) {
            logToLocal(userName, '5 perdas consecutivas. Parando.', 'error');
            stopBotSession(userId);
            return;
        }

        if (state.priceHistory.length < 50) return;

        const prices = state.priceHistory;
        const currentPrice = state.currentPrice;
        
        // Calcular todos os 6 indicadores
        const rsi = calculateRSI(prices, 14);
        const macd = calculateMACD(prices);
        const sma20 = calculateSMA(prices, 20);
        const ema20 = calculateEMA(prices, 20);
        const bollinger = calculateBollingerBands(prices, 20);
        const stochastic = calculateStochastic(prices, 14);
        
        // Sistema de pontuação para CALL
        let callScore = 0;
        let putScore = 0;
        
        // RSI
        if (rsi < conf.rsiLow) callScore += 20;
        if (rsi > conf.rsiHigh) putScore += 20;
        
        // MACD
        if (macd.histogram > 0) callScore += 15;
        if (macd.histogram < 0) putScore += 15;
        
        // SMA/EMA
        if (currentPrice > sma20 && currentPrice > ema20) callScore += 15;
        if (currentPrice < sma20 && currentPrice < ema20) putScore += 15;
        
        // Bollinger Bands
        if (bollinger) {
            if (currentPrice <= bollinger.lower) callScore += 25;
            if (currentPrice >= bollinger.upper) putScore += 25;
        }
        
        // Estocástico
        if (stochastic.k < 20) callScore += 15;
        if (stochastic.k > 80) putScore += 10;
        if (stochastic.k < 30 && stochastic.d < 30 && stochastic.k > stochastic.d) callScore += 10; // Cruzamento de alta
        if (stochastic.k > 70 && stochastic.d > 70 && stochastic.k < stochastic.d) putScore += 10; // Cruzamento de baixa
        
        // Decisão final baseada na pontuação
        const minScore = conf.minScore || 25;
        let signal = null;
        
        if (callScore >= minScore && callScore > putScore) {
            signal = 'CALL';
        } else if (putScore >= minScore && putScore > callScore) {
            signal = 'PUT';
        }
        
        // Log dos scores ocasionalmente
        if (signal && Math.random() < 0.1) {
            console.log(`[${userName}] Scores - CALL: ${callScore} | PUT: ${putScore}`);
        }

        if (signal) {
            console.log(`[${userName}] 📊 SINAL ${signal}! (C:${callScore} P:${putScore})`);
            logToLocal(userName, `Sinal ${signal} (C:${callScore} P:${putScore})`, 'info');
            startTradeWithSimulation(userId, session, signal);
        }

    }, 1000);
}

// Funções de simulação
function startTradeWithSimulation(userId, session, direction) {
    const state = session.state;
    const config = session.config;
    const userName = session.userName;
    const simulation = state.simulation;

    if (!session.ws || session.ws.readyState !== WebSocket.OPEN || simulation.active) return;

    simulation.active = true;
    simulation.direction = direction;
    simulation.startTime = Date.now();
    simulation.priceData = [];
    simulation.predictionScore = 0;
    simulation.priceAtStart = state.currentPrice;
    
    logToLocal(userName, `🔍 Simulando ${direction}...`, 'info');

    simulation.timer = setInterval(() => {
        updateSimulation(userId, session, 1.0);
    }, 100);
}

function updateSimulation(userId, session, duration) {
    const simulation = session.state.simulation;
    if (!simulation.active) return;

    const elapsed = (Date.now() - simulation.startTime) / 1000;
    
    if (session.state.currentPrice) {
        simulation.priceData.push({
            time: elapsed,
            price: session.state.currentPrice
        });
        
        if (simulation.priceData.length > 3) {
            analyzeTrend(session);
        }
    }
    
    if (elapsed >= duration) {
        finishSimulation(userId, session);
    }
}

function analyzeTrend(session) {
    const simulation = session.state.simulation;
    const config = session.config;

    if (simulation.priceData.length < 4) return;
    
    const recentPrices = simulation.priceData.slice(-4);
    const priceChanges = [];
    
    for (let i = 1; i < recentPrices.length; i++) {
        const change = ((recentPrices[i].price - recentPrices[i-1].price) / recentPrices[i-1].price) * 100;
        priceChanges.push(change);
    }
    
    const avgChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
    
    let isFavorable = false;
    
    if (simulation.direction === 'CALL') {
        isFavorable = avgChange > 0.001;
    } else if (simulation.direction === 'PUT') {
        isFavorable = avgChange < -0.001;
    }
    
    simulation.predictionScore = isFavorable ? 
        Math.min(100, simulation.predictionScore + 20) : 
        Math.max(0, simulation.predictionScore - 15);
    
    const minScore = config.minScore || 25;
    if (simulation.predictionScore >= minScore) {
        finishSimulation(session.userId, session);
    }
}

function finishSimulation(userId, session) {
    const simulation = session.state.simulation;
    const config = session.config;

    if (simulation.timer) clearInterval(simulation.timer);
    simulation.active = false;
    
    const minScore = config.minScore || 25;
    const shouldExecute = simulation.predictionScore >= minScore;
    
    if (shouldExecute) {
        logToLocal(session.userName, `✅ Executando ordem ${simulation.direction}`, 'success');
        buyContract(session.ws, config, simulation.direction);
        session.openContract = true;
    } else {
        logToLocal(session.userName, `❌ Cancelando ordem (score: ${simulation.predictionScore}%)`, 'warn');
    }
    
    simulation.direction = null;
}

function stopBotSession(userId) {
    if (activeSessions[userId]) {
        const session = activeSessions[userId];
        const userName = session.userName;
        
        if (session.ws) session.ws.close();
        if (session.strategyTimer) clearInterval(session.strategyTimer);
        if (session.state.simulation.timer) clearInterval(session.state.simulation.timer);
        
        updateLocalStatsFile(userName, session.state);
        
        if (usersData[userName]) {
            usersData[userName].isRunning = false;
            saveUsersData(usersData);
        }
        
        delete activeSessions[userId];
        console.log(`[${userName}] Bot parado.`);
    }
}

function buyContract(ws, config, direction) {
    const contractType = direction === 'CALL' ? 'CALL' : 'PUT';
    const symbol = config.symbol || 'R_100';

    let stakeAmount = config.stake;
    const sess = Object.values(activeSessions).find(s => s.ws === ws);
    
    if (sess && sess.state.consecutiveLosses >= 3) {
        stakeAmount = Math.max(0.35, stakeAmount * 0.5);
    }
    stakeAmount = Math.max(0.35, stakeAmount);

    const payload = {
        proposal: 1,
        amount: stakeAmount,
        basis: 'stake',
        contract_type: contractType,
        currency: 'USD',
        duration: 5,
        duration_unit: 't',
        symbol: symbol
    };

    try {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('⚠️ WebSocket não está aberto');
            return;
        }
        ws.send(JSON.stringify(payload));
    } catch (err) {
        console.error('Erro ao enviar ordem:', err.message);
    }
}

function logToLocal(userName, msg, type) {
    const time = new Date().toLocaleTimeString('pt-BR');
    
    if (!usersData[userName]) return;
    if (!usersData[userName].logs) usersData[userName].logs = [];
    
    usersData[userName].logs.push({ time, msg, type });
    if (usersData[userName].logs.length > 50) usersData[userName].logs.shift();
    
    saveUsersData(usersData);
}

function updateLocalStatsFile(userName, stats) {
    if (!usersData[userName]) return;

    if (!usersData[userName].stats) {
        usersData[userName].stats = {};
    }

    Object.assign(usersData[userName].stats, {
        dailyProfit: stats.dailyProfit,
        wins: stats.wins,
        losses: stats.losses,
        tradesToday: stats.tradesToday,
        consecutiveLosses: stats.consecutiveLosses,
        balance: stats.balance || 0,
        lastUpdate: new Date().toISOString()
    });
    
    saveUsersData(usersData);
}

// --- FUNÇÕES DOS 6 INDICADORES ---

// 1. RSI (Relative Strength Index)
function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change >= 0) gains += change;
        else losses += Math.abs(change);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// 2. MACD (Moving Average Convergence Divergence)
function calculateMACD(prices) {
    if (prices.length < 35) return { macd: 0, signal: 0, histogram: 0 };
    const ema12 = calculateEMA(prices, 12);
    const ema26 = calculateEMA(prices, 26);
    if (ema12 === null || ema26 === null) return { macd: 0, signal: 0, histogram: 0 };
    const macd = ema12 - ema26;
    
    const macdHistory = [];
    for (let i = 25; i < prices.length; i++) {
        const slice = prices.slice(0, i + 1);
        const e12 = calculateEMA(slice, 12);
        const e26 = calculateEMA(slice, 26);
        if (e12 !== null && e26 !== null) macdHistory.push(e12 - e26);
    }
    
    if (macdHistory.length < 9) return { macd, signal: 0, histogram: 0 };
    const signal = calculateEMA(macdHistory, 9);
    if (signal === null) return { macd, signal: 0, histogram: 0 };
    
    return { macd, signal, histogram: macd - signal };
}

// 3. SMA (Simple Moving Average)
function calculateSMA(prices, period) {
    if (prices.length < period) return null;
    const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
}

// 4. EMA (Exponential Moving Average)
function calculateEMA(prices, period) {
    if (prices.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
}

// 5. Bollinger Bands
function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
    if (prices.length < period) return null;
    const sma = calculateSMA(prices, period);
    const slice = prices.slice(-period);
    const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return { 
        upper: sma + (stdDevMultiplier * stdDev), 
        middle: sma, 
        lower: sma - (stdDevMultiplier * stdDev) 
    };
}

// 6. Estocástico (Stochastic Oscillator)
function calculateStochastic(prices, period = 14, smoothK = 3, smoothD = 3) {
    if (prices.length < period + smoothK + smoothD) {
        return { k: 50, d: 50 };
    }
    
    // Calcular %K
    const recentPrices = prices.slice(-period - smoothK);
    const kValues = [];
    
    for (let i = 0; i <= recentPrices.length - period; i++) {
        const window = recentPrices.slice(i, i + period);
        const high = Math.max(...window);
        const low = Math.min(...window);
        const current = window[window.length - 1];
        
        if (high !== low) {
            const k = ((current - low) / (high - low)) * 100;
            kValues.push(k);
        } else {
            kValues.push(50);
        }
    }
    
    // Suavizar %K
    let k = 50;
    if (kValues.length >= smoothK) {
        k = kValues.slice(-smoothK).reduce((a, b) => a + b, 0) / smoothK;
    }
    
    // Calcular %D (média de %K)
    let d = 50;
    if (kValues.length >= smoothK + smoothD) {
        const dValues = [];
        for (let i = kValues.length - smoothD; i < kValues.length; i++) {
            const dWindow = kValues.slice(i - smoothK + 1, i + 1);
            dValues.push(dWindow.reduce((a, b) => a + b, 0) / smoothK);
        }
        d = dValues.reduce((a, b) => a + b, 0) / smoothD;
    }
    
    return { k, d };
}

// Auto-restore
(function restoreRunningSessions() {
    try {
        Object.keys(usersData).forEach(userName => {
            const u = usersData[userName];
            if (u && u.isRunning && u.config && u.config.token && u.userId) {
                console.log(`🔄 Restaurando sessão para ${userName}`);
                startBotSession(u.userId, u.config.token, u.config);
            }
        });
    } catch (e) {
        console.error('Erro na restauração:', e.message);
    }
})();

// --- FUNÇÃO DE VERIFICAÇÃO DIÁRIA PARA REINICIAR APÓS STOP LOSS ---
function dailyCheckForRestart() {
    const todayStr = new Date().toISOString().split('T')[0];

    Object.keys(usersData).forEach(userName => {
        const user = usersData[userName];

        // Verifica se o bot foi parado por stop loss em um dia anterior
        if (user && user.stats && user.stats.stopLossHitDate && user.stats.stopLossHitDate !== todayStr) {
            console.log(`\n[SISTEMA] Novo dia detectado para ${userName}. Reativando bot após stop loss do dia anterior.`);
            
            user.stats.stopLossHitDate = null; // Limpa a flag
            user.isRunning = true; // Permite que o bot rode novamente
            
            saveUsersData(usersData);

            // Tenta iniciar a sessão se não estiver ativa e tiver configuração
            if (user.config && user.config.token && user.userId && !activeSessions[user.userId]) {
                console.log(`🔄 Reiniciando sessão para ${userName}.`);
                startBotSession(user.userId, user.config.token, user.config);
            }
        }
    });
}

// Inicia a verificação periódica (a cada hora)
setInterval(dailyCheckForRestart, 60 * 60 * 1000);

// Iniciar o programa
showMainMenu();