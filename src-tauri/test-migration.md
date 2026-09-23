# 配置迁移和 Provider 管理功能测试

## 测试环境准备

### 1. 备份现有配置
```bash
cp ~/Library/Application\ Support/com.paper-reader/settings.json ~/Desktop/settings-backup.json
```

### 2. 创建旧版配置文件进行测试
```json
{
  "api_keys": {
    "mineru": "test-mineru-key",
    "openai": "sk-openai-test",
    "anthropic": "sk-ant-test",
    "gemini": "",
    "deepseek": "sk-deepseek-test"
  },
  "paper_library_path": null,
  "embedding_model": "bge-small-en-v1.5",
  "llm_provider": "deepseek",
  "llm_model": "deepseek-chat",
  "web_search_provider": "auto",
  "web_search_model": null
}
```

## 测试场景

### 场景 1: 配置自动迁移测试

**步骤**：
1. 将上述旧版配置保存到 settings.json
2. 启动应用
3. 调用 `get_settings()` 检查迁移结果

**预期结果**：
- `providers` 数组包含 3 个元素（openai, anthropic, deepseek）
- `active_provider_id` 为 "deepseek"
- `mineru_api_key` 为 "test-mineru-key"
- deepseek provider 的 `default_model` 为 "deepseek-chat"

### 场景 2: 添加新 Provider

**步骤**：
```typescript
await addProvider({
  id: "custom-openai",
  name: "Custom OpenAI",
  provider_type: "openai-compat",
  api_key: "sk-custom-key",
  base_url: "https://api.custom.com/v1",
  default_model: "gpt-4o",
  models: ["gpt-4o", "gpt-4o-mini"],
  enabled: true
});
```

**预期结果**：
- 返回更新后的 Settings，providers 包含新添加的 provider
- settings.json 持久化成功

### 场景 3: 删除当前激活的 Provider（应失败）

**步骤**：
```typescript
// 假设当前 active_provider_id 为 "deepseek"
await deleteProvider("deepseek");
```

**预期结果**：
- 返回错误："不能删除当前激活的 provider 'deepseek'，请先切换到其他 provider"

### 场景 4: 切换激活 Provider

**步骤**：
```typescript
await setActiveProvider("openai");
```

**预期结果**：
- `active_provider_id` 更新为 "openai"
- settings.json 持久化成功

### 场景 5: 删除非激活 Provider（应成功）

**步骤**：
```typescript
// 先切换到 openai
await setActiveProvider("openai");
// 再删除 deepseek
await deleteProvider("deepseek");
```

**预期结果**：
- deepseek provider 被成功删除
- providers 列表不再包含 deepseek

### 场景 6: 更新 Provider 配置

**步骤**：
```typescript
await updateProvider("openai", {
  id: "openai", // id 会被保留
  name: "OpenAI (Updated)",
  provider_type: "openai-compat",
  api_key: "sk-new-key",
  base_url: "https://api.openai.com/v1",
  default_model: "gpt-4o",
  models: ["gpt-4o"],
  enabled: true
});
```

**预期结果**：
- openai provider 的配置被更新
- id 保持不变

### 场景 7: LLM 构造测试

**步骤**：
1. 确保有激活的 provider
2. 调用需要 LLM 的功能（如翻译、问答）

**预期结果**：
- `Llm::from_settings()` 成功从激活的 provider 构造实例
- API 调用正常工作

### 场景 8: 联网搜索配置测试

**步骤**：
1. 设置 `web_search_provider` 为 "auto"
2. 确保有启用的 deepseek 或 anthropic provider
3. 在问答中启用联网搜索

**预期结果**：
- `web_search_available()` 返回正确的 (provider, model)
- 联网搜索工具可用
- API key 从 providers 列表正确获取

## 手动测试步骤

### 使用浏览器控制台测试

1. 启动应用后打开开发者工具
2. 在控制台执行：

```javascript
// 获取当前设置
const settings = await window.__TAURI__.core.invoke('get_settings');
console.log('Current settings:', settings);

// 检查迁移结果
console.log('Providers:', settings.providers);
console.log('Active provider:', settings.active_provider_id);
console.log('MinerU key:', settings.mineru_api_key);

// 添加新 provider
const newSettings = await window.__TAURI__.core.invoke('add_provider', {
  config: {
    id: 'test-provider',
    name: 'Test Provider',
    provider_type: 'openai-compat',
    api_key: 'test-key',
    base_url: 'https://api.test.com',
    default_model: 'test-model',
    models: [],
    enabled: true
  }
});
console.log('After adding provider:', newSettings.providers);

// 切换激活 provider
const switched = await window.__TAURI__.core.invoke('set_active_provider', {
  id: 'test-provider'
});
console.log('Active provider after switch:', switched.active_provider_id);

// 尝试删除当前激活的 provider（应失败）
try {
  await window.__TAURI__.core.invoke('delete_provider', { id: 'test-provider' });
} catch (e) {
  console.log('Expected error:', e);
}

// 切换后再删除（应成功）
await window.__TAURI__.core.invoke('set_active_provider', { id: 'openai' });
const deleted = await window.__TAURI__.core.invoke('delete_provider', { id: 'test-provider' });
console.log('After deleting:', deleted.providers.map(p => p.id));
```

## 验证清单

- [ ] 旧配置自动迁移成功
- [ ] providers 列表正确生成
- [ ] active_provider_id 正确设置
- [ ] MinerU key 提取到顶层
- [ ] 添加 provider 成功
- [ ] 不能删除激活的 provider
- [ ] 切换激活 provider 成功
- [ ] 删除非激活 provider 成功
- [ ] 更新 provider 成功
- [ ] LLM 功能正常工作
- [ ] 联网搜索功能正常工作
- [ ] settings.json 正确持久化

## 恢复操作

测试完成后恢复原配置：
```bash
cp ~/Desktop/settings-backup.json ~/Library/Application\ Support/com.paper-reader/settings.json
```
