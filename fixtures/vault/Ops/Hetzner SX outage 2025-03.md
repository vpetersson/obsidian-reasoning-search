---
tags: [ops, incident]
---
# Summary
On 14 March one of the NVMe drives in the SX64 dedicated server died. mdadm marked the RAID 1 array as degraded and Postgres latency spiked.

# Timeline
- 09:12 alerting fired for I/O wait above 40%
- 09:30 `smartctl` showed reallocated sectors climbing on /dev/nvme1
- 10:05 opened a support ticket with Hetzner to swap the drive
- 11:20 replacement installed, resync started

# Follow-ups
- Add SMART monitoring to the Prometheus exporter
- Keep a spare drive budget for the next one
