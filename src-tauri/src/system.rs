//! Live CPU / RAM / GPU readings, pushed to the UI once a second.

use crate::model::SystemStats;
use crate::util::{emit, EventSink};
use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
use nvml_wrapper::Nvml;
use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Reads system statistics. NVIDIA details come from NVML when it is present;
/// on other machines the GPU fields stay empty.
pub struct Monitor {
    sys: System,
    nvml: Option<Nvml>,
    cpu_model: String,
    cpu_cores: u32,
}

impl Default for Monitor {
    fn default() -> Self {
        Self::new()
    }
}

impl Monitor {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let cpu_model = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "CPU".into());
        let cpu_cores = sys.cpus().len() as u32;
        Monitor { sys, nvml: Nvml::init().ok(), cpu_model, cpu_cores }
    }

    pub fn read(&mut self) -> SystemStats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        let mut stats = SystemStats {
            cpu_model: self.cpu_model.clone(),
            cpu_cores: self.cpu_cores,
            cpu_usage: self.sys.global_cpu_usage() as f64,
            ram_used_gb: self.sys.used_memory() as f64 / GB,
            ram_total_gb: self.sys.total_memory() as f64 / GB,
            gpu_name: None,
            gpu_usage: None,
            gpu_encoder_usage: None,
            gpu_mem_used_gb: None,
            gpu_mem_total_gb: None,
            gpu_temp_c: None,
        };
        if let Some(device) = self.nvml.as_ref().and_then(|n| n.device_by_index(0).ok()) {
            stats.gpu_name = device.name().ok();
            stats.gpu_usage = device.utilization_rates().ok().map(|u| u.gpu as f64);
            stats.gpu_encoder_usage = device.encoder_utilization().ok().map(|u| u.utilization as f64);
            if let Ok(mem) = device.memory_info() {
                stats.gpu_mem_used_gb = Some(mem.used as f64 / GB);
                stats.gpu_mem_total_gb = Some(mem.total as f64 / GB);
            }
            stats.gpu_temp_c = device.temperature(TemperatureSensor::Gpu).ok().map(|t| t as f64);
        }
        stats
    }
}

/// Start the background thread that emits `system:stats`.
pub fn spawn_monitor(sink: Arc<dyn EventSink>) {
    std::thread::Builder::new()
        .name("mvs-system-monitor".into())
        .spawn(move || {
            let mut monitor = Monitor::new();
            // CPU usage is a difference between two readings; prime it.
            std::thread::sleep(Duration::from_millis(400));
            loop {
                emit(&*sink, "system:stats", &monitor.read());
                std::thread::sleep(Duration::from_secs(1));
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sane_values() {
        let mut m = Monitor::new();
        std::thread::sleep(Duration::from_millis(250));
        let s = m.read();
        assert!(s.cpu_cores >= 1);
        assert!((0.0..=100.0).contains(&s.cpu_usage), "cpu {}", s.cpu_usage);
        assert!(s.ram_total_gb > 0.5);
        assert!(s.ram_used_gb > 0.0 && s.ram_used_gb <= s.ram_total_gb);
        if let Some(u) = s.gpu_usage {
            assert!((0.0..=100.0).contains(&u));
        }
    }
}
