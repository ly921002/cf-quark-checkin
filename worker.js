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
        await sendTelegramNotification(`✅ 夸克签到完成\n${result}`);
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
      await sendTelegramNotification(`✅ 夸克自动签到完成\n${result}`);
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
    COOKIE_QUARK: env.COOKIE_QUARK ? 
      env.COOKIE_QUARK.split(/\s*[&\n]+\s*/).filter(Boolean) : 
      config.COOKIE_QUARK
  };

  // 配置验证
  if (config.COOKIE_QUARK.some(c => !c.includes('='))) {
    throw new Error('存在无效的COOKIE_QUARK格式');
  }
}

async function runCheckin() {
  if (!config.COOKIE_QUARK.length) {
    throw new Error('❌ 未配置COOKIE_QUARK环境变量');
  }

  let results = [];
  for (const cookie of config.COOKIE_QUARK) {
    try {
      const userData = parseCookie(cookie);
      const result = await withRetry(() => quarkSign(userData), 3);
      results.push(result);
    } catch (error) {
      results.push(`❌ ${maskString(userData?.user || '未知用户')} 签到失败: ${error.message}`);
    }
  }
  return results.join('\n\n');
}

function parseCookie(cookie) {
  try {
    const entries = cookie
      .split(';')
      .map(p => p.trim().split('='))
      .filter(p => p.length === 2 && p.every(v => v.length > 0));
    
    if (entries.length === 0) throw new Error('无效Cookie格式');
    
    return Object.fromEntries(entries);
  } catch (e) {
    throw new Error(`Cookie解析失败: ${e.message}`);
  }
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

    const infoRes = await fetch(`${infoUrl}?${infoParams}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!infoRes.ok) throw new Error(`容量请求失败: ${infoRes.status}`);
    const infoData = await infoRes.json();
    if (!infoData.data) throw new Error('获取容量信息失败');

    // 执行签到
    const signUrl = 'https://drive-m.quark.cn/1/clouddrive/capacity/growth/sign';
    const signRes = await fetch(signUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': Object.entries(userData).map(([k,v]) => `${k}=${v}`).join('; ')
      },
      body: JSON.stringify({ sign_cyclic: true })
    });
    
    if (!signRes.ok) throw new Error(`签到请求失败: ${signRes.status}`);
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
    throw error; // 抛出错误供上层处理
  }
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function sendTelegramNotification(message) {
  if (!config.TG_BOT_TOKEN || !config.TG_CHAT_ID) return;

  const timeString = new Date().toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    hour12: false 
  });

  const payload = {
    chat_id: config.TG_CHAT_ID,
    text: `🕒 执行时间: ${timeString}\n` +
          `🌐 服务端: 夸克网盘\n` +
          `📥 处理账户数: ${config.COOKIE_QUARK.length}\n\n` +
          `${message.split('\n\n').map(m => `➖ ${m}`).join('\n\n')}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  const telegramAPI = `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await fetch(telegramAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(await response.text());
  } catch (error) {
    console.error('Telegram通知失败:', error);
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
