/**
 * 性能指标收集器
 *
 * 记录渲染各阶段耗时和缓存命中率，
 * 支持 Prometheus 格式导出。
 */

export interface RenderTiming {
  /** 模板生成耗时 (ms) */
  templateMs: number
  /** 资源等待耗时 (ms) */
  resourceMs: number
  /** 截图耗时 (ms) */
  screenshotMs: number
  /** 总耗时 (ms) */
  totalMs: number
  /** 时间戳 */
  timestamp: number
  /** 模板名称 */
  template: string
  /** 是否缓存命中 */
  cacheHit: boolean
}

// 使用环形缓冲区限制内存占用
const MAX_SAMPLES = 1000

class MetricsCollector {
  private totalRequests = 0
  private cacheHits = 0
  private cacheMisses = 0
  private errorCount = 0

  /** 最近 N 次渲染的耗时记录（环形缓冲） */
  private renderSamples: RenderTiming[] = []
  private sampleIndex = 0

  // 汇总统计
  private totalTemplateMs = 0
  private totalResourceMs = 0
  private totalScreenshotMs = 0
  private totalRenderMs = 0

  /** 记录一次完整的渲染 */
  recordRender(timing: RenderTiming): void {
    this.totalRequests++

    if (timing.cacheHit) {
      this.cacheHits++
    } else {
      this.cacheMisses++
      this.totalTemplateMs += timing.templateMs
      this.totalResourceMs += timing.resourceMs
      this.totalScreenshotMs += timing.screenshotMs
    }
    this.totalRenderMs += timing.totalMs

    // 环形缓冲区
    if (this.renderSamples.length < MAX_SAMPLES) {
      this.renderSamples.push(timing)
    } else {
      this.renderSamples[this.sampleIndex % MAX_SAMPLES] = timing
    }
    this.sampleIndex++
  }

  /** 记录错误 */
  recordError(): void {
    this.errorCount++
  }

  /** 计算分位数 */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, index)]
  }

  /** 获取所有指标 */
  getSnapshot() {
    const allSamples = this.renderSamples
    const nonCacheSamples = allSamples.filter((s) => !s.cacheHit)

    const totalMs = nonCacheSamples.map((s) => s.totalMs)
    const templateMs = nonCacheSamples.map((s) => s.templateMs)
    const resourceMs = nonCacheSamples.map((s) => s.resourceMs)
    const screenshotMs = nonCacheSamples.map((s) => s.screenshotMs)

    const nonCacheCount = this.cacheMisses
    const avgTemplate = nonCacheCount > 0 ? this.totalTemplateMs / nonCacheCount : 0
    const avgResource = nonCacheCount > 0 ? this.totalResourceMs / nonCacheCount : 0
    const avgScreenshot = nonCacheCount > 0 ? this.totalScreenshotMs / nonCacheCount : 0
    const avgTotal = this.totalRequests > 0 ? this.totalRenderMs / this.totalRequests : 0

    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRate: this.totalRequests > 0 ? this.cacheHits / this.totalRequests : 0,
      errorCount: this.errorCount,

      // 总耗时（含缓存命中）
      avgTotalMs: avgTotal,

      // 非缓存请求的各阶段统计
      avgTemplateMs: avgTemplate,
      avgResourceMs: avgResource,
      avgScreenshotMs: avgScreenshot,

      // 分位数（仅非缓存请求）
      totalP50: this.percentile(totalMs, 50),
      totalP95: this.percentile(totalMs, 95),
      totalP99: this.percentile(totalMs, 99),

      templateP50: this.percentile(templateMs, 50),
      templateP95: this.percentile(templateMs, 95),
      templateP99: this.percentile(templateMs, 99),

      resourceP50: this.percentile(resourceMs, 50),
      resourceP95: this.percentile(resourceMs, 95),
      resourceP99: this.percentile(resourceMs, 99),

      screenshotP50: this.percentile(screenshotMs, 50),
      screenshotP95: this.percentile(screenshotMs, 95),
      screenshotP99: this.percentile(screenshotMs, 99),

      sampleCount: allSamples.length,
      nonCacheSampleCount: nonCacheSamples.length,
    }
  }

  /** 导出 Prometheus 格式指标 */
  toPrometheus(): string {
    const snap = this.getSnapshot()

    const lines: string[] = [
      '# HELP poster_requests_total Total number of poster generation requests',
      '# TYPE poster_requests_total counter',
      `poster_requests_total ${snap.totalRequests}`,
      '',
      '# HELP poster_cache_hits_total Total number of cache hits',
      '# TYPE poster_cache_hits_total counter',
      `poster_cache_hits_total ${snap.cacheHits}`,
      '',
      '# HELP poster_cache_misses_total Total number of cache misses',
      '# TYPE poster_cache_misses_total counter',
      `poster_cache_misses_total ${snap.cacheMisses}`,
      '',
      '# HELP poster_errors_total Total number of rendering errors',
      '# TYPE poster_errors_total counter',
      `poster_errors_total ${snap.errorCount}`,
      '',
      '# HELP poster_cache_hit_rate Cache hit rate (0-1)',
      '# TYPE poster_cache_hit_rate gauge',
      `poster_cache_hit_rate ${snap.cacheHitRate.toFixed(4)}`,
      '',
      '# HELP poster_render_duration_ms Render duration in milliseconds',
      '# TYPE poster_render_duration_ms summary',
      `poster_render_duration_ms{quantile="0.5"} ${snap.totalP50}`,
      `poster_render_duration_ms{quantile="0.95"} ${snap.totalP95}`,
      `poster_render_duration_ms{quantile="0.99"} ${snap.totalP99}`,
      `poster_render_duration_ms_sum ${(snap.avgTotalMs * snap.totalRequests).toFixed(0)}`,
      `poster_render_duration_ms_count ${snap.totalRequests}`,
      '',
      '# HELP poster_template_duration_ms Template generation duration',
      '# TYPE poster_template_duration_ms summary',
      `poster_template_duration_ms{quantile="0.5"} ${snap.templateP50}`,
      `poster_template_duration_ms{quantile="0.95"} ${snap.templateP95}`,
      `poster_template_duration_ms{quantile="0.99"} ${snap.templateP99}`,
      `poster_template_duration_ms_sum ${(snap.avgTemplateMs * snap.nonCacheSampleCount).toFixed(0)}`,
      `poster_template_duration_ms_count ${snap.nonCacheSampleCount}`,
      '',
      '# HELP poster_resource_duration_ms Resource loading duration',
      '# TYPE poster_resource_duration_ms summary',
      `poster_resource_duration_ms{quantile="0.5"} ${snap.resourceP50}`,
      `poster_resource_duration_ms{quantile="0.95"} ${snap.resourceP95}`,
      `poster_resource_duration_ms{quantile="0.99"} ${snap.resourceP99}`,
      `poster_resource_duration_ms_sum ${(snap.avgResourceMs * snap.nonCacheSampleCount).toFixed(0)}`,
      `poster_resource_duration_ms_count ${snap.nonCacheSampleCount}`,
      '',
      '# HELP poster_screenshot_duration_ms Screenshot duration',
      '# TYPE poster_screenshot_duration_ms summary',
      `poster_screenshot_duration_ms{quantile="0.5"} ${snap.screenshotP50}`,
      `poster_screenshot_duration_ms{quantile="0.95"} ${snap.screenshotP95}`,
      `poster_screenshot_duration_ms{quantile="0.99"} ${snap.screenshotP99}`,
      `poster_screenshot_duration_ms_sum ${(snap.avgScreenshotMs * snap.nonCacheSampleCount).toFixed(0)}`,
      `poster_screenshot_duration_ms_count ${snap.nonCacheSampleCount}`,
      '',
    ]

    return lines.join('\n')
  }

  /** 重置所有统计 */
  reset(): void {
    this.totalRequests = 0
    this.cacheHits = 0
    this.cacheMisses = 0
    this.errorCount = 0
    this.renderSamples = []
    this.sampleIndex = 0
    this.totalTemplateMs = 0
    this.totalResourceMs = 0
    this.totalScreenshotMs = 0
    this.totalRenderMs = 0
  }
}

/** 全局单例 */
export const metrics = new MetricsCollector()
