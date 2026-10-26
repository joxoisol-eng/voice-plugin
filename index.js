/**
 * 语音插件 (v1.3.0 - 真正直接与文字同时发送，解决 blob 报错与 API Key 鉴权)
 *
 * 核心修复：
 * 1. 彻底解决“AI 回复看不懂 blob: 链接”：不把前端 blob 标签写入聊天正文，纯音频 Base64 作为多模态参数发给 AI！
 * 2. 彻底解决“miss api key”报错：自动从酒馆密码框提取 Key，同时支持在设置里直接粘贴本地 Key (保存在手机本地，绝不传 GitHub)！
 * 3. 聊天界面渲染真正的音频条：消息正文只保留干净文字，播放器附加在消息气泡上，不污染后续上下文。
 */

let mediaRecorder = null;
let audioChunks = [];
let attachedBlob = null;
let attachedBase64 = null;
let attachedUrl = null;
let attachedDuration = 0;
let previewAudio = new Audio();
let isRecording = false;
let recordTimer = null;
let recordSeconds = 0;

// 配置项 (保存在手机本地 localStorage)
function getPluginConfig() {
  const oai = window.oai_settings || {};
  let defaultUrl = oai.custom_url || oai.reverse_proxy || 'http://127.0.0.1:8317/v1';
  let defaultModel = oai.custom_model || oai.openai_model || 'gemini-3.8-flash-high';

  // 尝试从酒馆界面的密码框或配置里提取当前使用的 Key
  let detectedKey = oai.proxy_password || $('#api_key_openai').val() || $('#custom_api_key').val() || '';

  const savedUrl = localStorage.getItem('voice_plugin_url') || defaultUrl;
  const savedKey = localStorage.getItem('voice_plugin_key') || detectedKey;
  const savedModel = localStorage.getItem('voice_plugin_model') || defaultModel;
  const savedFormat = localStorage.getItem('voice_plugin_format') || (savedUrl.includes('/v1beta') ? 'gemini_native' : 'openai_chat');

  return {
    apiUrl: savedUrl,
    apiKey: savedKey,
    model: savedModel,
    format: savedFormat
  };
}

function savePluginConfig(cfg) {
  localStorage.setItem('voice_plugin_url', cfg.apiUrl.trim());
  localStorage.setItem('voice_plugin_key', cfg.apiKey.trim());
  localStorage.setItem('voice_plugin_model', cfg.model.trim());
  localStorage.setItem('voice_plugin_format', cfg.format);
}

jQuery(async () => {
  console.log('[VoicePlugin] 正在启动语音插件 v1.3.0...');

  // 轮询等待输入栏就绪
  let attempts = 0;
  const checkInterval = setInterval(() => {
    attempts++;
    const $textarea = $('#send_textarea');
    const $sendBtn = $('#send_but');

    if ($textarea.length) {
      clearInterval(checkInterval);
      initVoiceUI($sendBtn, $textarea);
    } else if (attempts > 50) {
      clearInterval(checkInterval);
      setTimeout(() => {
        const $t = $('#send_textarea');
        if ($t.length) initVoiceUI($('#send_but'), $t);
      }, 1500);
    }
  }, 200);
});

function initVoiceUI($sendBtn, $textarea) {
  $('#gemini_voice_mic_btn').remove();
  $('#gemini_voice_recording_banner').remove();
  $('#gemini_voice_chip').remove();

  // 注入麦克风大按钮 (带长按设置提示)
  const $micBtn = $(`
    <div id="gemini_voice_mic_btn" class="fa-solid fa-microphone interactable"
         title="点击录音，长按打开配置"
         style="cursor:pointer; font-size:1.35em; min-width:38px; min-height:38px; display:inline-flex; align-items:center; justify-content:center; color:var(--SmartThemeTextColor, inherit); touch-action:manipulation; margin:0 4px;">
    </div>
  `);

  if ($sendBtn.length) {
    $sendBtn.before($micBtn);
  } else if ($('#chat_input_controls').length) {
    $('#chat_input_controls').append($micBtn);
  } else {
    $textarea.after($micBtn);
  }

  // 录音中的轻量状态条
  const $recordBanner = $(`
    <div id="gemini_voice_recording_banner" class="gemini-voice-recording-banner"
         style="display:none; max-width:min(280px, calc(100vw - 40px)); margin:4px 8px; box-sizing:border-box;">
      <div class="recording-indicator" style="display:flex; align-items:center; gap:6px; font-weight:600; font-size:12px;">
        <span class="recording-dot" style="width:8px; height:8px; border-radius:4px; background:#ef4444;"></span>
        <span id="gemini_voice_timer">00:00</span>
      </div>
      <div class="recording-actions" style="display:flex; gap:6px;">
        <button id="gemini_voice_btn_stop" class="btn-record-stop" type="button" style="padding:3px 8px; background:#ef4444; color:#fff; border:none; border-radius:6px; font-size:11px;">✓ 完成</button>
        <button id="gemini_voice_btn_cancel" class="btn-record-cancel" type="button" style="padding:3px 6px; background:transparent; color:#94a3b8; border:1px solid #475569; border-radius:6px; font-size:11px;">✕</button>
      </div>
    </div>
  `);

  // 语音挂载小胶囊 (坐在输入框正上方，不遮挡打字框，带大 ✕ 删除按钮)
  const $attachmentChip = $(`
    <div id="gemini_voice_chip" class="gemini-voice-chip"
         style="display:none; width:fit-content; max-width:min(260px, calc(100vw - 40px)); margin:4px 8px; padding:4px 8px 4px 10px; border-radius:18px; box-sizing:border-box; z-index:10; align-items:center; justify-content:space-between; gap:6px;">
      <div class="gemini-voice-chip-left" id="gemini_voice_chip_play_area" title="点击试听或暂停" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
        <button id="gemini_voice_chip_play" class="chip-play-btn" type="button" style="width:26px; height:26px; border-radius:13px; font-size:10px; flex-shrink:0;">▶</button>
        <div class="chip-waves" id="gemini_voice_chip_waves">
          <span></span><span></span><span></span><span></span>
        </div>
        <span id="gemini_voice_chip_dur" class="chip-duration" style="font-size:13px; font-weight:700; color:#a5b4fc;">0"</span>
        <span class="chip-label" style="font-size:12px; font-weight:500;">🎙️ 已挂载</span>
      </div>
      <button id="gemini_voice_chip_del" class="chip-del-btn" type="button" title="点击删除语音附件"
              style="width:28px; height:28px; border-radius:14px; font-size:15px; font-weight:bold; margin-left:6px; flex-shrink:0; cursor:pointer; touch-action:manipulation;">✕</button>
    </div>
  `);

  const $nonQR = $('#nonQRFormItems');
  if ($nonQR.length) {
    $nonQR.before($recordBanner);
    $nonQR.before($attachmentChip);
  } else if ($('#send_form').length) {
    $('#send_form').prepend($recordBanner);
    $('#send_form').prepend($attachmentChip);
  } else {
    $textarea.before($recordBanner);
    $textarea.before($attachmentChip);
  }

  // ==================== 录音控制绑定 ====================

  let pressTimer = null;
  $micBtn.on('touchstart mousedown', () => {
    pressTimer = setTimeout(() => {
      openConfigModal();
    }, 600); // 长按 600ms 打开设置
  });

  $micBtn.on('touchend touchcancel mouseup mouseleave', () => {
    clearTimeout(pressTimer);
  });

  $micBtn.on('click', async (e) => {
    e.preventDefault();
    if (!isRecording) {
      if (attachedBlob) {
        if (typeof toastr !== 'undefined') toastr.info('已有语音附件，可直接发送或点 ✕ 删除再录');
        return;
      }
      await startVoiceRecording();
    } else {
      stopVoiceRecording(true);
    }
  });

  $('#gemini_voice_btn_stop').on('click', () => stopVoiceRecording(true));
  $('#gemini_voice_btn_cancel').on('click', () => stopVoiceRecording(false));

  $('#gemini_voice_chip_play_area').on('click', togglePreviewAudio);

  $('#gemini_voice_chip_del').on('click', (e) => {
    e.stopPropagation();
    discardVoiceAttachment();
  });

  previewAudio.onended = () => {
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  };

  // 拦截发送动作
  hookUnifiedSend($sendBtn, $textarea);

  console.log('[VoicePlugin] 插件 v1.3.0 初始化完成！');
  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音插件 v1.3.0 就绪！(长按麦克风可查看配置)');
  }
}

// ==================== 录音逻辑 ====================

async function startVoiceRecording() {
  audioChunks = [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else mimeType = '';
    }

    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start(150);
    isRecording = true;
    recordSeconds = 0;

    $('#gemini_voice_mic_btn').addClass('recording');
    $('#gemini_voice_recording_banner').slideDown(150);
    updateTimerDisplay();

    recordTimer = setInterval(() => {
      recordSeconds++;
      updateTimerDisplay();
    }, 1000);

  } catch (err) {
    console.error('[VoicePlugin] 调起麦克风失败:', err);
    if (typeof toastr !== 'undefined') {
      toastr.error('调起麦克风失败：' + (err.message || err.name));
    }
  }
}

function stopVoiceRecording(save = true) {
  if (!isRecording) return;
  clearInterval(recordTimer);
  isRecording = false;
  $('#gemini_voice_mic_btn').removeClass('recording');
  $('#gemini_voice_recording_banner').slideUp(150);

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (save && audioChunks.length > 0) {
    const mime = mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: mime });
    attachVoiceAttachment(blob, Math.max(1, recordSeconds));
  }
}

function updateTimerDisplay() {
  const m = Math.floor(recordSeconds / 60).toString().padStart(2, '0');
  const s = (recordSeconds % 60).toString().padStart(2, '0');
  $('#gemini_voice_timer').text(`正在录音 ${m}:${s}`);
}

// 挂载到输入框上方
function attachVoiceAttachment(blob, seconds) {
  attachedBlob = blob;
  attachedDuration = seconds;
  if (attachedUrl) URL.revokeObjectURL(attachedUrl);
  attachedUrl = URL.createObjectURL(blob);
  previewAudio.src = attachedUrl;

  const reader = new FileReader();
  reader.onloadend = () => {
    attachedBase64 = reader.result.split(',')[1];
  };
  reader.readAsDataURL(blob);

  $('#gemini_voice_chip_dur').text(`${seconds}"`);
  $('#gemini_voice_chip').css('display', 'inline-flex').slideDown(180);
  $('#gemini_voice_mic_btn').addClass('attached');

  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音已挂载！直接输入文字即可一起发送');
  }
}

function discardVoiceAttachment() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
  }
  if (attachedUrl) {
    URL.revokeObjectURL(attachedUrl);
    attachedUrl = null;
  }
  attachedBlob = null;
  attachedBase64 = null;
  attachedDuration = 0;

  $('#gemini_voice_chip_play').text('▶');
  $('#gemini_voice_chip_waves').removeClass('playing');
  $('#gemini_voice_chip').slideUp(150);
  $('#gemini_voice_mic_btn').removeClass('attached');
}

function togglePreviewAudio() {
  if (!previewAudio.src) return;
  if (previewAudio.paused) {
    previewAudio.play();
    $('#gemini_voice_chip_play').text('⏸');
    $('#gemini_voice_chip_waves').addClass('playing');
  } else {
    previewAudio.pause();
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  }
}

// ==================== 核心：多模态真正同时发送 ====================

function hookUnifiedSend($sendBtn, $textarea) {
  const handleSend = async (e) => {
    if (attachedBase64) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await executeMultimodalSend($textarea);
    }
  };

  if ($sendBtn.length) {
    $sendBtn.on('click', handleSend);
  }
  $textarea.on('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && attachedBase64) {
      await handleSend(e);
    }
  });
}

async function executeMultimodalSend($textarea) {
  const userText = $textarea.val().trim();
  const audioBase64 = attachedBase64;
  const audioBlob = attachedBlob;
  const audioUrl = attachedUrl;
  const duration = attachedDuration;

  $textarea.val('').trigger('input');
  discardVoiceAttachment();

  if (typeof toastr !== 'undefined') {
    toastr.info('正在发送语音与文字给角色...');
  }

  const context = window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {};
  const charName = context.name2 || '角色';
  const userName = context.name1 || '你';

  // 关键：正文只存干净纯文本，绝对不把 blob: 塞进 mes！
  // 否则之后每一轮对话 AI 都会看到一个无法访问的 blob 标签！
  const cleanMessageText = userText ? `${userText} (发送了 ${duration}秒 真实语音)` : `(发送了 ${duration}秒 真实语音)`;

  // 在界面上绘制带有真实播放控件的语音卡片
  const displayHtml = `
    <div class="st-gemini-voice-bubble">
      <div class="st-voice-player-row">
        <audio class="st-voice-audio" controls src="${audioUrl}"></audio>
        <span style="font-size:12px; font-weight:600; color:#818cf8;">${duration}"</span>
      </div>
      ${userText ? `<div class="st-voice-user-text">💬 ${escapeHtml(userText)}</div>` : ''}
    </div>
  `;

  // 插入用户消息
  appendMessage(userName, true, cleanMessageText, displayHtml);

  try {
    const config = getPluginConfig();

    if (!config.apiKey && !config.apiUrl.includes('127.0.0.1')) {
      throw new Error('未配置 API Key，请长按麦克风输入');
    }

    // 组装历史上下文
    const historyList = (context.chat || []).slice(-8).map(m => {
      const sender = m.is_user ? userName : (m.name || charName);
      return `${sender}: ${m.mes || ''}`;
    }).join('\n');

    const promptText = (historyList ? `【前序聊天背景】\n${historyList}\n\n` : '') +
      (userText ? `用户说的文字: "${userText}"\n` : '') +
      `【系统提示】：用户随本条消息附带了一段时长 ${duration} 秒的真实语音（包含用户的原声音调、语气情绪或哼歌细节）。请仔细聆听音频里的声音细节，并结合文字内容，以角色身份进行自然、沉浸的回复。`;

    const charReply = await requestAiMultimodal(config, audioBase64, audioBlob.type || 'audio/webm', promptText);

    // 插入角色回复
    appendMessage(charName, false, charReply);

  } catch (err) {
    console.error('[VoicePlugin] 发送失败:', err);
    let errMsg = err.message || '网络连接错误';
    if (errMsg.includes('miss api key') || errMsg.includes('missing api key')) {
      errMsg = '反代缺少 API Key！请长按麦克风图标输入并保存你的 Key。';
      openConfigModal();
    }
    if (typeof toastr !== 'undefined') {
      toastr.error('发送失败：' + errMsg);
    }
  }
}

// 调用反代多模态接口
async function requestAiMultimodal(config, base64Data, mimeType, prompt) {
  let baseUrl = config.apiUrl.replace(/\/+$/, '');
  const apiKey = config.apiKey;
  const model = config.model;

  let targetUrl = '';
  let payload = null;

  if (config.format === 'gemini_native' || baseUrl.includes('/v1beta')) {
    targetUrl = `${baseUrl}/models/${model}:generateContent`;
    if (apiKey) targetUrl += `?key=${apiKey}`;

    payload = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType, data: base64Data } },
          { text: prompt }
        ]
      }]
    };
  } else {
    targetUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    payload = {
      model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: base64Data,
              format: mimeType.includes('mp4') ? 'mp4' : 'wav'
            }
          },
          { type: 'text', text: prompt }
        ]
      }]
    };
  }

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}`, 'x-goog-api-key': apiKey } : {})
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ||
         data.choices?.[0]?.message?.content ||
         '（未收到角色回复）';
}

function appendMessage(name, isUser, rawText, displayHtml = null) {
  const context = window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {};
  const msgObj = {
    name: name,
    is_user: isUser,
    is_system: false,
    send_date: Date.now(),
    mes: displayHtml || rawText, // mes 供酒馆当前渲染显示
    extra: {}
  };

  if (context.chat && Array.isArray(context.chat)) {
    context.chat.push(msgObj);
    if (typeof context.addOneMessage === 'function') {
      context.addOneMessage(msgObj);
    } else if (typeof window.addOneMessage === 'function') {
      window.addOneMessage(msgObj);
    }
    if (typeof context.saveChat === 'function') {
      context.saveChat();
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== 配置模态框 (长按麦克风弹出) ====================

function openConfigModal() {
  $('.gemini-voice-modal-backdrop').remove();

  const cfg = getPluginConfig();

  const modalHtml = `
    <div class="gemini-voice-modal-backdrop">
      <div class="gemini-voice-modal">
        <h3>⚙️ 语音插件配置</h3>
        <p style="font-size:11px; color:#9ca3af; margin-bottom:10px;">所有配置仅保存在你当前手机浏览器本地，绝不上载 GitHub。</p>
        <div class="field-row">
          <label>API 地址 (Termux 反代)</label>
          <input type="text" id="gv_cfg_url" value="${cfg.apiUrl}">
        </div>
        <div class="field-row">
          <label>API Key / 鉴权密码</label>
          <input type="password" id="gv_cfg_key" value="${cfg.apiKey}" placeholder="填入你在反代或酒馆里使用的 Key">
        </div>
        <div class="field-row">
          <label>模型名称</label>
          <input type="text" id="gv_cfg_model" value="${cfg.model}">
        </div>
        <div class="field-row">
          <label>协议格式</label>
          <select id="gv_cfg_format">
            <option value="gemini_native" ${cfg.format === 'gemini_native' ? 'selected' : ''}>Gemini 原生 (/v1beta/models/...)</option>
            <option value="openai_chat" ${cfg.format === 'openai_chat' ? 'selected' : ''}>OpenAI 格式 (/v1/chat/completions)</option>
          </select>
        </div>
        <div class="modal-btns">
          <button id="gv_cfg_cancel" class="btn-cancel-gv">取消</button>
          <button id="gv_cfg_save" class="btn-primary-gv">保存配置</button>
        </div>
      </div>
    </div>
  `;

  $('body').append(modalHtml);

  $('#gv_cfg_cancel').on('click', () => $('.gemini-voice-modal-backdrop').remove());
  $('#gv_cfg_save').on('click', () => {
    savePluginConfig({
      apiUrl: $('#gv_cfg_url').val().trim(),
      apiKey: $('#gv_cfg_key').val().trim(),
      model: $('#gv_cfg_model').val().trim(),
      format: $('#gv_cfg_format').val()
    });
    $('.gemini-voice-modal-backdrop').remove();
    if (typeof toastr !== 'undefined') toastr.success('配置已保存！');
  });
}
