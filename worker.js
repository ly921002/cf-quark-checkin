const DEFAULT_CONFIG = {
  TRIGGER_PATH: '/quark-checkin',
  TG_BOT_TOKEN: '',
  TG_CHAT_ID: '',
  COOKIE_QUARK: []
};

let config = { ...DEFAULT_CONFIG };

export default {
  async fetch(request, env, ctx) {
    await initializeConfig(env);
    const url = new URL(request.url);
    
    if (url.pathname === config.TRIGGER_PATH) {
      try {
        const result = await runCheckin();
        await sendTelegramNotification(`✅ 夸克签到成功\n${result}`);
        return successResponse(result);
      } catch (error) {
        await sendTelegramNotification(`❌ 夸克签到失败\n${error.message}`);
        return errorResponse(error);
      }
    } else if (url.pathname === '/') {
      return new Response(
        `请访问 ${config.TRIGGER_PATH} 触发夸克签到`,
        { 
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
        }
      );
    }
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await initializeConfig(env);
    try {
      const result = await runCheckin();
      await sendTelegramNotification(`✅ 夸克自动签到成功\n${result}`);
    } catch (error) {
      await sendTelegramNotification(`❌ 夸克自动签到失败\n${error.message}`);
    }
  }
};

async function initializeConfig(env) {
  config = {
    TRIGGER_PATH: env.TRIGGER_PATH || config.TRIGGER_PATH,
    TG_BOT_TOKEN: env.TG_BOT_TOKEN || config.TG_BOT_TOKEN,
    TG_CHAT_ID: env.TG_CHAT_ID || config.TG_CHAT_ID,
    COOKIE_QUARK: env.COOKIE_QUARK ? env.COOKIE_QUARK.split(/&&|\n/) : config.COOKIE_QUARK
  };
}

async function runCheckin() {
  if (!config.COOKIE_QUARK.length) {
    throw new Error('❌ 未配置COOKIE_QUARK环境变量');
  }

  let results = [];
  for (const cookie of config.COOKIE_QUARK) {
    const userData = parseCookie(cookie);
    const result = await quarkSign(userData);
    results.push(result);
  }
  return results.join('\n\n');
}

function parseCookie(cookie) {
  return Object.fromEntries(
    cookie.split(';')
      .map(p => p.trim().split('='))
      .filter(p => p.length === 2)
  );
}

async function quarkSign(userData) {
  try {
    // 获取容量信息
    const infoUrl = 'https://drive-m.quark.cn/1/clouddrive/capacity/growth/info';
    const infoParams = new URLSearchParams({
      pr: 'ucpro',
      fr: 'android',
      ...userData
    });

    const infoRes = await fetch(`${infoUrl}?${infoParams}`);
    const infoData = await infoRes.json();
    
    if (!infoData.data) throw new Error('获取容量信息失败');

    // 执行签到
    const signUrl = 'https://drive-m.quark.cn/1/clouddrive/capacity/growth/sign';
    const signParams = new URLSearchParams(infoParams);
    
    const signRes = await fetch(signUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': Object.entries(userData).map(([k,v]) => `${k}=${v}`).join('; ')
      },
      body: JSON.stringify({ sign_cyclic: true })
    });
    
    const signData = await signRes.json();
    
    // 构建结果
    let result = `📧 用户: ${maskString(userData.user || '未知用户')}`;
    result += `\n💾 总容量: ${convertBytes(infoData.data.total_capacity)}`;
    
    if (signData.data) {
      result += `\n✅ 签到成功: +${convertBytes(signData.data.sign_daily_reward)}`;
      result += `\n连续签到: ${infoData.data.cap_sign.sign_progress + 1}/${infoData.data.cap_sign.sign_target}`;
    } else {
      result += `\n❌ 签到失败: ${signData.message}`;
    }
    
    return result;
  } catch (error) {
    console.error('夸克签到异常:', error);
    return `❌ 签到异常: ${error.message}`;
  }
}

function convertBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(2)} ${units[i]}`;
}

async function sendTelegramNotification(message) {
  if (!config.TG_BOT_TOKEN || !config.TG_CHAT_ID) return;

  const timeString = new Date().toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    hour12: false 
  });

  const payload = {
    chat_id: config.TG_CHAT_ID,
    text: `🕒 执行时间: ${timeString}\n\n${message}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  const telegramAPI = `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/sendMessage`;
  
  try {
    await fetch(telegramAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error('Telegram通知失败:', error);
  }
}

function maskString(str, visibleStart = 2, visibleEnd = 2) {
  if (!str) return '';
  if (str.length <= visibleStart + visibleEnd) return str;
  return `${str.substring(0, visibleStart)}****${str.substring(str.length - visibleEnd)}`;
}

function successResponse(data) {
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
  });
}

function errorResponse(error) {
  return new Response(error.message, {
    status: 500,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
  });
}
