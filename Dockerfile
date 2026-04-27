FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    sudo curl wget git vim nano jq \
    python3 python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG AGENT_USER=niri
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN set -eux; \
    if getent group "${AGENT_GID}" >/dev/null 2>&1; then \
      group_name="$(getent group "${AGENT_GID}" | cut -d: -f1)"; \
    else \
      group_name="${AGENT_USER}"; \
      groupadd -g "${AGENT_GID}" "${group_name}"; \
    fi; \
    existing_user="$(getent passwd "${AGENT_UID}" | cut -d: -f1 || true)"; \
    if [ -n "${existing_user}" ] && [ "${existing_user}" != "${AGENT_USER}" ]; then \
      usermod -l "${AGENT_USER}" "${existing_user}"; \
      usermod -d "/home/${AGENT_USER}" -m "${AGENT_USER}"; \
    elif ! id -u "${AGENT_USER}" >/dev/null 2>&1; then \
      useradd -m -u "${AGENT_UID}" -g "${group_name}" -s /bin/bash "${AGENT_USER}"; \
    fi; \
    usermod -u "${AGENT_UID}" "${AGENT_USER}" 2>/dev/null || true; \
    usermod -g "${AGENT_GID}" "${AGENT_USER}"; \
    echo "${AGENT_USER} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers; \
    mkdir -p "/home/${AGENT_USER}"; \
    chown -R "${AGENT_UID}:${AGENT_GID}" "/home/${AGENT_USER}"

WORKDIR /home/$AGENT_USER
USER $AGENT_USER

CMD ["sleep", "infinity"]
