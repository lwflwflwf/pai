# Copyright (c) Microsoft Corporation
# All rights reserved.
#
# MIT License
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
# to permit persons to whom the Software is furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
# BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
# DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

FROM ubuntu:16.04

RUN apt-get -y update && \
    apt-get -y install \
      nano \
      vim \
      joe \
      wget \
      curl \
      jq \
      gawk \
      psmisc \
      python \
      python-yaml \
      python-jinja2 \
      python-paramiko \
      python-urllib3 \
      python-tz \
      python-nose \
      python-prettytable \
      python-netifaces \
      python-dev \
      python-pip \
      python-mysqldb \
      openjdk-8-jre=8u191-b12-0ubuntu0.16.04.1 \
      openjdk-8-jdk=8u191-b12-0ubuntu0.16.04.1 \
      openssh-server \
      openssh-client \
      git \
      bash-completion \
      inotify-tools \
      rsync \
      realpath \
      net-tools && \
    mkdir -p /cluster-configuration &&\
    git clone https://github.com/Microsoft/pai.git &&\
    pip install python-etcd docker kubernetes GitPython

WORKDIR /tmp

ENV JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64

RUN echo "source /usr/share/bash-completion/completions/git" >> ~/.bashrc

# Only node manager need this.#
RUN wget https://download.docker.com/linux/static/stable/x86_64/docker-17.06.2-ce.tgz
RUN tar xzvf docker-17.06.2-ce.tgz
RUN mv docker/* /usr/local/bin/

# alert manager tool
RUN wget https://github.com/prometheus/alertmanager/releases/download/v0.15.2/alertmanager-0.15.2.linux-amd64.tar.gz
RUN tar xzvf alertmanager-0.15.2.linux-amd64.tar.gz
RUN mv alertmanager-0.15.2.linux-amd64/amtool /usr/local/bin

# install Azure CLI for deploy on  Azure AKS
RUN echo "deb [arch=amd64] https://packages.microsoft.com/repos/azure-cli/ xenial main" | \
    tee /etc/apt/sources.list.d/azure-cli.list

RUN curl -L https://packages.microsoft.com/keys/microsoft.asc | apt-key add -

RUN apt-get -y install apt-transport-https &&  \
    apt-get -y update && \
    apt-get -y install azure-cli

RUN wget https://storage.googleapis.com/kubernetes-release/release/$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)/bin/linux/amd64/kubectl
RUN chmod +x kubectl
RUN mv kubectl /usr/local/bin

# reinstall requests otherwise will get error: `cannot import name DependencyWarning`
RUN echo y | pip uninstall requests && \
    echo y | pip install requests && \
    echo y | pip install docopt

RUN rm -rf /tmp/*

WORKDIR /
# checkout OpenPAI release branch at start-script
COPY build/start-script.sh /usr/local
RUN chmod u+x /usr/local/start-script.sh

CMD ["/usr/local/start-script.sh"]

