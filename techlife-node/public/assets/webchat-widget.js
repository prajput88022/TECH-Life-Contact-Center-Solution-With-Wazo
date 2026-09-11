/**
 * TECH-Life Webchat Widget -- embed on any customer-facing website with:
 *   <script src="https://your-techlife-host/assets/webchat-widget.js"
 *           data-public-key="YOUR_WIDGET_PUBLIC_KEY"
 *           data-api-base="https://your-techlife-host"></script>
 *
 * Self-contained: no dependencies, injects its own bubble/panel DOM and
 * styles. Talks only to the public, unauthenticated /chat-widget/*
 * endpoints (routes/chatWidget.js) -- never touches any tenant-login
 * session.
 */
(function () {
    var script = document.currentScript;
    var publicKey = script.getAttribute('data-public-key');
    var apiBase = (script.getAttribute('data-api-base') || '').replace(/\/$/, '');
    if (!publicKey || !apiBase) {
        console.error('TECH-Life webchat widget: data-public-key and data-api-base are required');
        return;
    }

    var conversationId = null;
    var lastMessageId = null;
    var pollTimer = null;

    var style = document.createElement('style');
    style.textContent =
        '.tlwc-bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:99999;font-family:sans-serif;font-size:24px}' +
        '.tlwc-panel{position:fixed;bottom:88px;right:20px;width:320px;height:440px;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,sans-serif;z-index:99999}' +
        '.tlwc-panel.open{display:flex}' +
        '.tlwc-header{background:#2563eb;color:#fff;padding:12px 14px;font-weight:600;font-size:14px}' +
        '.tlwc-messages{flex:1;overflow-y:auto;padding:10px;font-size:13px}' +
        '.tlwc-msg{margin:6px 0;padding:8px 10px;border-radius:10px;max-width:80%;line-height:1.4}' +
        '.tlwc-msg.customer{background:#2563eb;color:#fff;margin-left:auto}' +
        '.tlwc-msg.agent,.tlwc-msg.bot,.tlwc-msg.system{background:#f0f2f7;color:#1a2233}' +
        '.tlwc-input-row{display:flex;border-top:1px solid #eee;padding:8px}' +
        '.tlwc-input-row input{flex:1;border:1px solid #ddd;border-radius:6px;padding:8px;font-size:13px}' +
        '.tlwc-input-row button{margin-left:6px;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:0 12px;cursor:pointer}';
    document.head.appendChild(style);

    var bubble = document.createElement('div');
    bubble.className = 'tlwc-bubble';
    bubble.innerHTML = '&#128172;';
    document.body.appendChild(bubble);

    var panel = document.createElement('div');
    panel.className = 'tlwc-panel';
    panel.innerHTML =
        '<div class="tlwc-header">Chat with us</div>' +
        '<div class="tlwc-messages" id="tlwc-messages"></div>' +
        '<div class="tlwc-input-row"><input id="tlwc-input" placeholder="Type a message…"><button id="tlwc-send">Send</button></div>';
    document.body.appendChild(panel);

    function addMessage(sender, body) {
        var el = document.createElement('div');
        el.className = 'tlwc-msg ' + sender;
        el.textContent = body;
        document.getElementById('tlwc-messages').appendChild(el);
        document.getElementById('tlwc-messages').scrollTop = 999999;
    }

    async function startConversation() {
        var res = await fetch(apiBase + '/chat-widget/' + publicKey + '/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        });
        var data = await res.json();
        if (data.conversation_id) {
            conversationId = data.conversation_id;
            addMessage('system', data.welcome_message);
            pollTimer = setInterval(poll, 3000);
        }
    }

    async function poll() {
        if (!conversationId) return;
        var qs = 'conversation_id=' + conversationId + (lastMessageId ? '&after_id=' + lastMessageId : '');
        var res = await fetch(apiBase + '/chat-widget/' + publicKey + '/poll?' + qs);
        var data = await res.json();
        (data.messages || []).forEach(function (m) {
            if (m.sender_type !== 'customer') addMessage(m.sender_type, m.body);
            lastMessageId = m.id;
        });
    }

    async function sendMessage() {
        var input = document.getElementById('tlwc-input');
        var body = input.value.trim();
        if (!body) return;
        if (!conversationId) await startConversation();
        addMessage('customer', body);
        input.value = '';
        await fetch(apiBase + '/chat-widget/' + publicKey + '/message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversationId, body: body })
        });
        poll();
    }

    bubble.addEventListener('click', function () {
        panel.classList.toggle('open');
        if (panel.classList.contains('open') && !conversationId) startConversation();
    });
    panel.querySelector('#tlwc-send').addEventListener('click', sendMessage);
    panel.querySelector('#tlwc-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMessage(); });
})();
