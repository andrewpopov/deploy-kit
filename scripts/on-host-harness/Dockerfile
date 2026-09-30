FROM debian:12
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus libpam-systemd openssh-server git curl ca-certificates sudo procps \
    && rm -rf /var/lib/apt/lists/*
# node 24 (NodeSource ships arm64) + pm2, like the real host
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/* \
    && npm install -g pm2
RUN useradd -m -d /srv/dkapp -s /bin/bash dkapp && usermod -p '*' dkapp \
    && install -d -m 700 -o dkapp -g dkapp /srv/dkapp/.ssh \
    && install -d /var/lib/systemd/linger && touch /var/lib/systemd/linger/dkapp \
    && install -d -o dkapp -g dkapp /srv/upstream \
    && mkdir -p /run/sshd
COPY seed /opt/seed
RUN chmod +x /opt/seed/bootstrap.sh && su dkapp -c /opt/seed/bootstrap.sh
# OOM-score parity (README "On-host deploys"): without these the user manager's units sit at 200
# while an ssh session sits at 0, and host-run refuses with ONHOST_OOM_SCORE.
RUN mkdir -p /etc/systemd/system/user@.service.d /etc/systemd/user.conf.d \
    && printf '[Service]\nOOMScoreAdjust=0\n' > /etc/systemd/system/user@.service.d/oom-parity.conf \
    && printf '[Manager]\nDefaultOOMScoreAdjust=0\n' > /etc/systemd/user.conf.d/oom-parity.conf
COPY pm2-dkapp.service /etc/systemd/system/pm2-dkapp.service
RUN systemctl enable ssh pm2-dkapp \
    && systemctl mask getty.target console-getty.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
