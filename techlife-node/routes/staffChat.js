const express = require('express');
const { pool } = require('../src/db');
const { requireRole } = require('../src/auth');
const { requireFeature } = require('../src/tenantFeatures');
const { isScopedSupervisor, agentAccessPredicate } = require('../src/supervisorScope');

module.exports = function createStaffChatRouter(area) {
    const router = express.Router();
    const allowedRoles = {
        agent: ['agent'],
        supervisor: ['supervisor', 'admin', 'superadmin'],
        admin: ['admin']
    };

    router.use(requireRole(allowedRoles[area] || []));
    router.use(requireFeature('staff_chat'));

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const basePath = `/${area}/staff-chat`;

    function tenantFor(req) {
        return area === 'admin'
            ? (req.effectiveTenant?.id || req.session.user.tenantId)
            : req.session.user.tenantId;
    }

    function idsFrom(value) {
        const values = Array.isArray(value) ? value : (value ? [value] : []);
        return [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
    }

    function httpError(status, message) {
        const error = new Error(message);
        error.status = status;
        return error;
    }

    async function loadDirectory(db, tenantId, user) {
        const scoped = area === 'supervisor' && isScopedSupervisor(user);
        const scopeSql = scoped
            ? `AND (
                EXISTS (
                    SELECT 1
                    FROM agents scope_ag
                    WHERE scope_ag.tenant_id = usr.tenant_id
                      AND scope_ag.user_id = usr.id
                      AND scope_ag.is_active = TRUE
                      AND ${agentAccessPredicate('scope_ag', '$1', '$2')}
                )
                OR EXISTS (
                    SELECT 1
                    FROM user_roles sur
                    JOIN roles sr
                      ON sr.id = sur.role_id
                     AND sr.tenant_id = usr.tenant_id
                    WHERE sur.user_id = usr.id
                      AND sr.role_type::text = 'admin'
                )
            )`
            : '';

        const result = await db.query(
            `SELECT
                usr.id,
                COALESCE(NULLIF(usr.full_name, ''), usr.username) AS display_name,
                usr.username,
                ag.agent_number,
                COALESCE(
                    array_agg(DISTINCT r.role_type::text)
                        FILTER (WHERE r.role_type IS NOT NULL),
                    ARRAY[]::text[]
                ) AS roles
             FROM users usr
             LEFT JOIN agents ag
               ON ag.tenant_id = usr.tenant_id
              AND ag.user_id = usr.id
              AND ag.is_active = TRUE
             LEFT JOIN user_roles ur ON ur.user_id = usr.id
             LEFT JOIN roles r
               ON r.id = ur.role_id
              AND r.tenant_id = usr.tenant_id
             WHERE usr.tenant_id = $1
               AND usr.is_active = TRUE
               AND usr.id <> $2
               ${scopeSql}
             GROUP BY usr.id, ag.id
             ORDER BY display_name, usr.username`,
            [tenantId, user.id]
        );

        return result.rows;
    }

    async function loadAudienceOptions(db, tenantId) {
        const [groups, queues, campaigns] = await Promise.all([
            db.query(
                `SELECT id, name FROM user_groups
                 WHERE tenant_id = $1 AND is_active = TRUE
                 ORDER BY name`,
                [tenantId]
            ),
            db.query(
                `SELECT id, name FROM queues
                 WHERE tenant_id = $1 AND is_active = TRUE
                 ORDER BY name`,
                [tenantId]
            ),
            db.query(
                `SELECT id, name FROM campaigns
                 WHERE tenant_id = $1 AND is_active = TRUE
                 ORDER BY name`,
                [tenantId]
            )
        ]);

        return {
            groups: groups.rows,
            queues: queues.rows,
            campaigns: campaigns.rows
        };
    }

    async function resolveRecipients(db, tenantId, user, targetType, targetId, selectedIds) {
        if (targetType === 'selected') {
            if (!selectedIds.length || selectedIds.length > 100 ||
                selectedIds.some(id => !uuidPattern.test(id))) {
                throw httpError(422, 'Select between 1 and 100 valid staff members.');
            }

            const directory = await loadDirectory(db, tenantId, user);
            const eligible = new Set(directory.map(row => row.id));
            const valid = selectedIds.filter(id => eligible.has(id));

            if (valid.length !== selectedIds.length) {
                throw httpError(403, 'One or more selected staff members are outside your permitted scope.');
            }

            return valid;
        }

        if (area !== 'admin') {
            throw httpError(403, 'Only tenant administrators can send audience announcements.');
        }

        if (!['group', 'queue', 'campaign'].includes(targetType) ||
            !targetId || !uuidPattern.test(targetId)) {
            throw httpError(422, 'Select a valid group, queue or campaign.');
        }

        let result;

        if (targetType === 'group') {
            result = await db.query(
                `SELECT DISTINCT usr.id
                 FROM user_groups ug
                 JOIN user_group_agents uga
                   ON uga.tenant_id = ug.tenant_id
                  AND uga.group_id = ug.id
                 JOIN agents ag
                   ON ag.tenant_id = uga.tenant_id
                  AND ag.id = uga.agent_id
                 JOIN users usr
                   ON usr.tenant_id = ag.tenant_id
                  AND usr.id = ag.user_id
                 WHERE ug.tenant_id = $1
                   AND ug.id = $2
                   AND ug.is_active = TRUE
                   AND ag.is_active = TRUE
                   AND usr.is_active = TRUE`,
                [tenantId, targetId]
            );
        } else if (targetType === 'queue') {
            result = await db.query(
                `SELECT DISTINCT usr.id
                 FROM queues q
                 JOIN queue_agents qa
                   ON qa.tenant_id = q.tenant_id
                  AND qa.queue_id = q.id
                 JOIN agents ag
                   ON ag.tenant_id = qa.tenant_id
                  AND ag.id = qa.agent_id
                 JOIN users usr
                   ON usr.tenant_id = ag.tenant_id
                  AND usr.id = ag.user_id
                 WHERE q.tenant_id = $1
                   AND q.id = $2
                   AND q.is_active = TRUE
                   AND qa.is_active = TRUE
                   AND ag.is_active = TRUE
                   AND usr.is_active = TRUE`,
                [tenantId, targetId]
            );
        } else {
            result = await db.query(
                `SELECT DISTINCT usr.id
                 FROM campaigns c
                 JOIN campaign_agents ca
                   ON ca.tenant_id = c.tenant_id
                  AND ca.campaign_id = c.id
                 JOIN agents ag
                   ON ag.tenant_id = ca.tenant_id
                  AND ag.id = ca.agent_id
                 JOIN users usr
                   ON usr.tenant_id = ag.tenant_id
                  AND usr.id = ag.user_id
                 WHERE c.tenant_id = $1
                   AND c.id = $2
                   AND c.is_active = TRUE
                   AND ag.is_active = TRUE
                   AND usr.is_active = TRUE`,
                [tenantId, targetId]
            );
        }

        const recipients = result.rows.map(row => row.id);

        if (!recipients.length) {
            throw httpError(422, 'The selected audience has no active staff recipients.');
        }

        return recipients;
    }

    async function findConversation(db, tenantId, conversationId, user, lock = false) {
        const result = await db.query(
            `SELECT
                sc.*,
                EXISTS (
                    SELECT 1
                    FROM staff_conversation_members scm
                    WHERE scm.tenant_id = sc.tenant_id
                      AND scm.conversation_id = sc.id
                      AND scm.user_id = $3
                      AND scm.is_active = TRUE
                ) AS is_member,
                (
                    $4 = 'admin'
                    AND sc.created_by_user_id = $3
                ) AS is_creator
             FROM staff_conversations sc
             WHERE sc.tenant_id = $1
               AND sc.id = $2
               AND (
                    EXISTS (
                        SELECT 1
                        FROM staff_conversation_members scm
                        WHERE scm.tenant_id = sc.tenant_id
                          AND scm.conversation_id = sc.id
                          AND scm.user_id = $3
                          AND scm.is_active = TRUE
                    )
                    OR ($4 = 'admin' AND sc.created_by_user_id = $3)
               )
             ${lock ? 'FOR UPDATE OF sc' : ''}`,
            [tenantId, conversationId, user.id, area]
        );

        return result.rows[0] || null;
    }

    async function markRead(tenantId, conversationId, userId) {
        await pool.query(
            `INSERT INTO staff_message_reads (tenant_id, message_id, user_id)
             SELECT m.tenant_id, m.id, $3
             FROM staff_messages m
             WHERE m.tenant_id = $1
               AND m.conversation_id = $2
               AND m.sender_user_id IS DISTINCT FROM $3
             ON CONFLICT (message_id, user_id) DO NOTHING`,
            [tenantId, conversationId, userId]
        );

        await pool.query(
            `UPDATE staff_conversation_members scm
             SET last_read_message_id = GREATEST(
                    scm.last_read_message_id,
                    COALESCE((
                        SELECT MAX(m.id)
                        FROM staff_messages m
                        WHERE m.tenant_id = $1
                          AND m.conversation_id = $2
                    ), 0)
                 )
             WHERE scm.tenant_id = $1
               AND scm.conversation_id = $2
               AND scm.user_id = $3
               AND scm.is_active = TRUE`,
            [tenantId, conversationId, userId]
        );
    }

    async function loadMessages(db, tenantId, conversationId) {
        const result = await db.query(
            `SELECT
                m.id,
                m.sender_user_id,
                COALESCE(NULLIF(u.full_name, ''), u.username, 'Former staff member') AS sender_name,
                CASE WHEN m.deleted_at IS NULL THEN m.body ELSE 'This message was removed.' END AS body,
                m.created_at,
                m.deleted_at,
                (
                    SELECT COUNT(*)
                    FROM staff_message_reads smr
                    WHERE smr.tenant_id = m.tenant_id
                      AND smr.message_id = m.id
                ) AS read_count
             FROM staff_messages m
             LEFT JOIN users u ON u.id = m.sender_user_id
             WHERE m.tenant_id = $1
               AND m.conversation_id = $2
             ORDER BY m.id ASC
             LIMIT 500`,
            [tenantId, conversationId]
        );

        return result.rows;
    }

    async function loadPageData(req, selectedConversation, messages) {
        const tenantId = tenantFor(req);
        const user = req.session.user;

        const conversations = await pool.query(
            `SELECT
                sc.id,
                sc.conversation_type,
                sc.title,
                sc.audience_type,
                sc.updated_at,
                COALESCE(
                    NULLIF(sc.title, ''),
                    CASE
                        WHEN sc.conversation_type = 'direct' THEN (
                            SELECT COALESCE(NULLIF(other.full_name, ''), other.username)
                            FROM staff_conversation_members om
                            JOIN users other
                              ON other.tenant_id = om.tenant_id
                             AND other.id = om.user_id
                            WHERE om.tenant_id = sc.tenant_id
                              AND om.conversation_id = sc.id
                              AND om.user_id <> $2
                            ORDER BY om.joined_at
                            LIMIT 1
                        )
                        WHEN sc.conversation_type = 'announcement' THEN 'Announcement'
                        ELSE 'Group conversation'
                    END
                ) AS display_title,
                COALESCE((
                    SELECT CASE
                        WHEN lm.deleted_at IS NULL THEN lm.body
                        ELSE 'This message was removed.'
                    END
                    FROM staff_messages lm
                    WHERE lm.tenant_id = sc.tenant_id
                      AND lm.conversation_id = sc.id
                    ORDER BY lm.id DESC
                    LIMIT 1
                ), 'No messages yet') AS last_message,
                (
                    SELECT COUNT(*)
                    FROM staff_messages um
                    WHERE um.tenant_id = sc.tenant_id
                      AND um.conversation_id = sc.id
                      AND um.sender_user_id IS DISTINCT FROM $2
                      AND um.id > COALESCE(scm.last_read_message_id, 0)
                      AND um.deleted_at IS NULL
                ) AS unread_count
             FROM staff_conversations sc
             LEFT JOIN staff_conversation_members scm
               ON scm.tenant_id = sc.tenant_id
              AND scm.conversation_id = sc.id
              AND scm.user_id = $2
              AND scm.is_active = TRUE
             WHERE sc.tenant_id = $1
               AND (
                    scm.user_id = $2
                    OR ($3 = 'admin' AND sc.created_by_user_id = $2)
               )
             ORDER BY sc.updated_at DESC
             LIMIT 100`,
            [tenantId, user.id, area]
        );

        const directory = await loadDirectory(pool, tenantId, user);
        const audiences = area === 'admin'
            ? await loadAudienceOptions(pool, tenantId)
            : { groups: [], queues: [], campaigns: [] };

        return {
            pageTitle: 'Internal Staff Chat',
            area,
            basePath,
            tenantId,
            currentUserId: user.id,
            currentUserName: user.fullName || user.username,
            agentId: area === 'agent' ? user.agentId : null,
            conversations: conversations.rows,
            directory,
            audiences,
            selectedConversation,
            messages,
            canSend: Boolean(
                selectedConversation &&
                !selectedConversation.is_archived &&
                (selectedConversation.is_member || selectedConversation.is_creator)
            )
        };
    }

    router.get('/', async (req, res) => {
        try {
            const data = await loadPageData(req, null, []);
            res.render('staff_chat/index', data);
        } catch (err) {
            console.error('Staff chat inbox error:', err);
            res.status(500).send('Unable to load staff chat.');
        }
    });

    router.post('/new', async (req, res) => {
        const user = req.session.user;
        const tenantId = tenantFor(req);
        const mode = String(req.body?.conversation_type || 'direct');
        const selectedIds = idsFrom(req.body?.recipient_user_ids);
        const title = String(req.body?.title || '').trim().slice(0, 200);

        if (!['direct', 'group', 'announcement'].includes(mode)) {
            return res.status(422).send('Invalid conversation type.');
        }
        if (mode === 'announcement' && area !== 'admin') {
            return res.status(403).send('Only tenant administrators can create announcements.');
        }

        const targetType = mode === 'announcement'
            ? String(req.body?.target_type || '')
            : 'selected';

        const targetId = mode === 'announcement'
            ? String(req.body?.target_id || '').trim() || null
            : null;

        const client = await pool.connect();
        let transactionOpen = false;

        try {
            await client.query('BEGIN');
            transactionOpen = true;

            const recipientIds = await resolveRecipients(
                client,
                tenantId,
                user,
                targetType,
                targetId,
                selectedIds
            );

            if (mode === 'direct' && recipientIds.length !== 1) {
                throw httpError(422, 'A direct conversation requires exactly one recipient.');
            }

            if (recipientIds.length > 100) {
                throw httpError(422, 'A conversation cannot have more than 100 recipients.');
            }

            const audienceType = mode === 'announcement'
                ? targetType
                : (mode === 'direct' ? 'direct' : 'selected');
            const audienceId = ['group', 'queue', 'campaign'].includes(audienceType)
                ? targetId
                : null;

            const created = await client.query(
                `INSERT INTO staff_conversations
                    (tenant_id, conversation_type, audience_type, audience_id,
                     title, created_by_user_id)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 RETURNING id`,
                [
                    tenantId,
                    mode,
                    audienceType,
                    audienceId,
                    title || null,
                    user.id
                ]
            );

            const conversationId = created.rows[0].id;

            // Reseller admins may be creating a conversation in a managed
            // sub-tenant. Add the creator as a member only if their account
            // actually belongs to that tenant.
            const senderInTenant = await client.query(
                `SELECT id FROM users
                 WHERE tenant_id = $1 AND id = $2 AND is_active = TRUE`,
                [tenantId, user.id]
            );

            const memberIds = [...recipientIds];
            if (senderInTenant.rowCount) memberIds.unshift(user.id);

            for (const memberId of [...new Set(memberIds)]) {
                await client.query(
                    `INSERT INTO staff_conversation_members
                        (tenant_id, conversation_id, user_id, member_role)
                     VALUES ($1,$2,$3,$4)
                     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
                    [
                        tenantId,
                        conversationId,
                        memberId,
                        memberId === user.id ? 'owner' : 'member'
                    ]
                );
            }

            await client.query('COMMIT');
            transactionOpen = false;

            return res.redirect(`${basePath}/${conversationId}`);
        } catch (err) {
            if (transactionOpen) {
                await client.query('ROLLBACK').catch(() => {});
            }

            if (err.status) return res.status(err.status).send(err.message);

            console.error('Staff chat creation failed:', err);
            return res.status(500).send('Unable to create staff conversation.');
        } finally {
            client.release();
        }
    });

    router.get('/:id/messages.json', async (req, res) => {
        const tenantId = tenantFor(req);
        const user = req.session.user;

        try {
            const conversation = await findConversation(
                pool, tenantId, req.params.id, user
            );

            if (!conversation) {
                return res.status(404).json({ error: 'conversation_not_found' });
            }

            if (conversation.is_member) {
                await markRead(tenantId, conversation.id, user.id);
            }

            const messages = await loadMessages(pool, tenantId, conversation.id);
            return res.json({ messages });
        } catch (err) {
            console.error('Staff chat polling failed:', err);
            return res.status(500).json({ error: 'staff_chat_poll_failed' });
        }
    });

    router.post('/:id/send', async (req, res) => {
        const tenantId = tenantFor(req);
        const user = req.session.user;
        const body = String(req.body?.body || '').trim();

        if (!body || body.length > 4000) {
            return res.status(422).json({ error: 'message_must_be_1_to_4000_characters' });
        }

        const client = await pool.connect();
        let transactionOpen = false;

        try {
            await client.query('BEGIN');
            transactionOpen = true;

            const conversation = await findConversation(
                client, tenantId, req.params.id, user, true
            );

            if (!conversation) {
                throw httpError(404, 'Conversation not found.');
            }
            if (conversation.is_archived) {
                throw httpError(409, 'This conversation is archived.');
            }

            const inserted = await client.query(
                `INSERT INTO staff_messages
                    (tenant_id, conversation_id, sender_user_id, body)
                 VALUES ($1,$2,$3,$4)
                 RETURNING id, created_at`,
                [tenantId, conversation.id, user.id, body]
            );

            await client.query(
                `UPDATE staff_conversations
                 SET updated_at = NOW()
                 WHERE tenant_id = $1 AND id = $2`,
                [tenantId, conversation.id]
            );

            await client.query('COMMIT');
            transactionOpen = false;

            return res.json({
                ok: true,
                message_id: inserted.rows[0].id,
                created_at: inserted.rows[0].created_at
            });
        } catch (err) {
            if (transactionOpen) {
                await client.query('ROLLBACK').catch(() => {});
            }

            if (err.status) return res.status(err.status).json({ error: err.message });

            console.error('Staff chat send failed:', err);
            return res.status(500).json({ error: 'staff_chat_send_failed' });
        } finally {
            client.release();
        }
    });

    router.get('/:id', async (req, res) => {
        const tenantId = tenantFor(req);
        const user = req.session.user;

        try {
            const conversation = await findConversation(
                pool, tenantId, req.params.id, user
            );

            if (!conversation) {
                return res.status(404).send('Staff conversation not found.');
            }

            if (conversation.is_member) {
                await markRead(tenantId, conversation.id, user.id);
            }

            const messages = await loadMessages(pool, tenantId, conversation.id);
            const data = await loadPageData(req, conversation, messages);

            return res.render('staff_chat/index', data);
        } catch (err) {
            console.error('Staff chat thread error:', err);
            return res.status(500).send('Unable to load staff conversation.');
        }
    });

    return router;
};
