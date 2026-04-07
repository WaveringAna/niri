FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    sudo curl wget git vim nano jq \
    python3 python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG AGENT_USER=niri
RUN useradd -m -s /bin/bash $AGENT_USER \
    && echo "$AGENT_USER ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

WORKDIR /home/$AGENT_USER

CMD ["sleep", "infinity"]
