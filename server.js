'use strict';

const path = require('path');
const express = require('express');
const { solve, replan, MAX_SCENES, normalizeProps } = require('./solver');
const store = require('./store');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 校验并规范化 { mode, timeLimit, scenes, constraints }，返回 { errors, mode, timeLimit, scenes, constraints } */
function validatePayload(body) {
  const errors = [];
  const rawMode = body && body.mode;
  if (rawMode !== undefined && rawMode !== 'classic' && rawMode !== 'timed') {
    errors.push(`未知的编排模式：${String(rawMode)}`);
  }
  const mode = rawMode === 'timed' ? 'timed' : 'classic';

  // 整场时长上限（仅 timed 模式使用）
  let timeLimit = Number(body && body.timeLimit);
  if (mode === 'timed') {
    if (!Number.isFinite(timeLimit) || !Number.isInteger(timeLimit) || timeLimit <= 0) {
      errors.push('整场时长上限必须是正整数（分钟）');
      timeLimit = 0;
    }
  } else if (Number.isFinite(timeLimit) && timeLimit >= 0) {
    timeLimit = timeLimit;
  } else {
    timeLimit = 0;
  }

  const rawScenes = body && body.scenes;
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    errors.push('至少需要 1 个场景');
  }
  const scenes = [];
  if (Array.isArray(rawScenes)) {
    if (rawScenes.length > MAX_SCENES) errors.push(`场景数量不能超过 ${MAX_SCENES} 个`);
    const ids = new Set();
    rawScenes.forEach((s, i) => {
      const id = String((s && s.id) ?? `s${i + 1}`);
      const name = String((s && s.name) ?? '').trim();
      if (!name) errors.push(`第 ${i + 1} 个场景缺少名称`);
      if (ids.has(id)) errors.push(`场景 id 重复：${id}`);
      ids.add(id);

      const scene = { id, name, props: normalizeProps(s && s.props) };
      if (mode === 'timed') {
        const duration = Number(s && s.duration);
        if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration < 0) {
          errors.push(`场景「${name || id}」的时长必须是非负整数（分钟）`);
        } else {
          scene.duration = duration;
        }
        scene.required = !!(s && s.required);
        const value = Number(s && s.value);
        scene.value = (!scene.required && Number.isFinite(value) && value > 0) ? Math.floor(value) : 0;
      }
      scenes.push(scene);
    });
  }

  const idSet = new Set(scenes.map(s => s.id));
  const c = (body && body.constraints) || {};
  const dependencies = [];
  const fixedPositions = [];
  const forbiddenAdjacencies = [];

  for (const d of c.dependencies || []) {
    if (!idSet.has(d.before) || !idSet.has(d.after)) {
      errors.push('依赖约束引用了不存在的场景');
      continue;
    }
    dependencies.push({ before: d.before, after: d.after });
  }
  for (const f of c.fixedPositions || []) {
    const pos = Number(f.position);
    if (!idSet.has(f.sceneId)) {
      errors.push('固定序位约束引用了不存在的场景');
      continue;
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > scenes.length) {
      errors.push(`固定序位必须是 1 到 ${scenes.length} 之间的整数`);
      continue;
    }
    fixedPositions.push({ sceneId: f.sceneId, position: pos });
  }
  for (const f of c.forbiddenAdjacencies || []) {
    if (!idSet.has(f.a) || !idSet.has(f.b)) {
      errors.push('禁止相邻约束引用了不存在的场景');
      continue;
    }
    forbiddenAdjacencies.push({ a: f.a, b: f.b });
  }

  return {
    errors,
    mode,
    timeLimit,
    scenes,
    constraints: { dependencies, fixedPositions, forbiddenAdjacencies },
  };
}

/**
 * 在校验过的求解载荷基础上，校验"演出中重排"参数。
 * 返回 { replan } = { prefixIds, stageProps, originalOrder } 或 errors。
 */
function validateReplan(body, scenes) {
  const errors = [];
  const idSet = new Set(scenes.map(s => s.id));

  const rawPrefix = body && body.replan && body.replan.prefixIds;
  const prefixIds = [];
  const seen = new Set();
  if (rawPrefix !== undefined) {
    if (!Array.isArray(rawPrefix)) {
      errors.push('已完成前缀必须是场景 id 数组');
    } else if (rawPrefix.length > scenes.length) {
      errors.push('已完成前缀长度不能超过场景总数');
    } else {
      for (const id0 of rawPrefix) {
        const id = String(id0);
        if (!idSet.has(id)) { errors.push(`已完成前缀引用了不存在的场景：${id}`); continue; }
        if (seen.has(id)) { errors.push(`已完成前缀中场景重复：${id}`); continue; }
        seen.add(id);
        prefixIds.push(id);
      }
    }
  }

  const stageProps = normalizeProps(body && body.replan && body.replan.stageProps);
  if (stageProps.length > 60) errors.push('当前舞台道具数量不能超过 60 个');

  let originalOrder;
  const rawOrder = body && body.replan && body.replan.originalOrder;
  if (rawOrder !== undefined) {
    if (!Array.isArray(rawOrder)) {
      errors.push('原计划顺序必须是场景 id 数组');
      originalOrder = [];
    } else {
      originalOrder = rawOrder.map(String).filter(id => idSet.has(id));
    }
  } else {
    originalOrder = [];
  }

  return { errors, replan: { prefixIds, stageProps, originalOrder } };
}

/** 校验方案保存载荷里附带的重排状态（可选；字段不合法则忽略该状态，不阻断保存）。 */
function sanitizeReplanState(raw, idSet) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.prefixIds) || raw.prefixIds.length === 0) return null;
  const seen = new Set();
  const prefixIds = [];
  for (const id0 of raw.prefixIds) {
    const id = String(id0);
    if (!idSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    prefixIds.push(id);
  }
  if (!prefixIds.length) return null;
  const stageProps = normalizeProps(raw.stageProps).slice(0, 60);
  const originalOrder = Array.isArray(raw.originalOrder)
    ? raw.originalOrder.map(String).filter(id => idSet.has(id))
    : prefixIds.slice();
  const chainStart = Array.isArray(raw.chainStartOrder)
    ? raw.chainStartOrder.map(String).filter(id => idSet.has(id))
    : originalOrder.slice();
  return { prefixIds, stageProps, originalOrder, chainStartOrder: chainStart };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/solve', (req, res) => {
  const { errors, mode, timeLimit, scenes, constraints } = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ ok: false, errors });
  res.json(solve(scenes, constraints, { mode, timeLimit }));
});

/** 演出中重排：确认已完成连续前缀 + 当前舞台实际道具，只重排剩余场景 */
app.post('/api/replan', (req, res) => {
  const { errors, mode, timeLimit, scenes, constraints } = validatePayload(req.body);
  const { errors: rpErrors, replan: replanOpts } = validateReplan(req.body, scenes || []);
  if (errors.length || rpErrors.length) {
    return res.status(400).json({ ok: false, errors: [...errors, ...rpErrors] });
  }
  res.json(replan(scenes, constraints, { mode, timeLimit, replan: replanOpts }));
});

app.get('/api/plans', (req, res) => {
  res.json({ plans: store.list() });
});

app.post('/api/plans', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ ok: false, errors: ['方案名称不能为空'] });
  const { errors, mode, timeLimit, scenes, constraints } = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ ok: false, errors });
  const replanState = sanitizeReplanState(req.body && req.body.replanState, new Set(scenes.map(s => s.id)));
  const plan = store.create({ name, mode, timeLimit, scenes, constraints, replanState });
  res.status(201).json({ ok: true, plan });
});

app.get('/api/plans/:id', (req, res) => {
  const plan = store.get(req.params.id);
  if (!plan) return res.status(404).json({ ok: false, errors: ['方案不存在'] });
  res.json({ ok: true, plan });
});

app.put('/api/plans/:id', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ ok: false, errors: ['方案名称不能为空'] });
  const { errors, mode, timeLimit, scenes, constraints } = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ ok: false, errors });
  const replanState = sanitizeReplanState(req.body && req.body.replanState, new Set(scenes.map(s => s.id)));
  const plan = store.update(req.params.id, { name, mode, timeLimit, scenes, constraints, replanState });
  if (!plan) return res.status(404).json({ ok: false, errors: ['方案不存在'] });
  res.json({ ok: true, plan });
});

app.delete('/api/plans/:id', (req, res) => {
  if (!store.remove(req.params.id)) {
    return res.status(404).json({ ok: false, errors: ['方案不存在'] });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`舞台换景顺序优化服务已启动: http://localhost:${PORT}`);
});
