import { createYouTubeAutomation } from './boot.js';
import { logger } from '../logger.js';

try { process.loadEnvFile(); } catch { /* Environment can be provided by the supervisor. */ }

try {
  const automation = createYouTubeAutomation(process.env, {
    onEvent: (event, data) => logger.info(event, data),
  });
  if (!automation) {
    console.log('youtube_monitor_disabled');
  } else {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await automation.stop();
      process.exit(0);
    };
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    automation.start();
    console.log('youtube_monitor_started schedule=07:00-22:00_hourly timezone=Asia/Shanghai quota_alerts=70%,90%');
  }
} catch {
  console.error('youtube_monitor_start_failed_check_config');
  process.exitCode = 1;
}
