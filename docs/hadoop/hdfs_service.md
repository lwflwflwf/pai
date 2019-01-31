# HDFS

This guidance provides users instructions to operate the HDFS cluster in OpenPAI.

# Table of Content

- [ Goal ](#Goal)
- [ Build ](#Build)
- [ Configuration ](#Configuration)
    - [ Properties Configuration ](#Properties_Configuration)
    - [ Storage Path ](#Storage_Path)
        - [ Name Node ](#Name_Node)
        - [ Data Node ](#Data_Node)
    - [ Data Migration ](#Data_Migration)
- [ Deployment ](#Deployment)
- [ Upgrading ](#Upgrading)
- [ Service Monitoring ](#Service_Monitoring)
    - [ Metrics ](#Metrics)
    - [ Monitoring ](#Monitoring)
        - [ Monitor via Prometheus ](#Monitor_via_Prometheus)
        - [ Monitor via HTTP API ](#Monitor_via_HTTP_API)
- [ High Availability ](#High_Availability)
- [ Access HDFS Data ](#Access_HDFS_Data)
- [ Reference ](#Reference)
- [FAQ](#FAQ)

# Goal <a name="Goal"></a>

 The Hadoop Distributed File System (HDFS) in OpenPAI serves as a central storage for both user's application and data.
 The application log will also be stored to HDFS.

# Build <a name="Build"></a>

The HDFS service image can be built together with other services by running this command:
```bash
python pai_build.py build -c /path/to/configuration/
```
HDFS is in the hadoop-run image, it can be built respectively with following commands:
```bash
python pai_build.py push -c /path/to/configuration/ -i hadoop-run
```

# Configuration <a name="Configuration"></a>

## Properties Configuration <a name="Properties_Configuration"></a>

HDFS name node and data node both have it configuration files.
They are located in [name node configuration](../../src/hadoop-name-node/deploy/hadoop-name-node-configuration)
and [data node configuration](../../src/hadoop-data-node/deploy/hadoop-data-node-configuration) respectively.
All the HDFS related properties are in file *core-site.xml* and *hdfs-site.xml*. 
Please refer [core-site.xml](https://hadoop.apache.org/docs/r2.9.0/hadoop-project-dist/hadoop-common/core-default.xml)
and [hdfs-site.xml](https://hadoop.apache.org/docs/r2.9.0/hadoop-project-dist/hadoop-hdfs/hdfs-default.xml)
for the detailed property descriptions.
  
## Storage Path <a name="Storage_Path"></a>

By default, HDFS stores metadata, tmpdata and data blocks following global setting of *${cluster.common.data-path}* in 
file [services-configuration.yaml](../../examples/cluster-configuration/services-configuration.yaml).
For the major disk consumers of data blocks, its path could be overwritten by *${hadoop-data-node.storage_path}*, 
which supports a comma-delimited list of directories to configure multiple disks.

### Name Node <a name="Name_Node"></a>

* Configuration Data: Its path is defined by *hadoop-name-node-configuration* configuration map. 
* Name Data: It is in the *hdfs/name* directory under the storage path.
* Temp Data: It is in the *hadooptmp/namenode* directory under the storage path.

### Data Node <a name="Data_Node"></a>

* Configuration Data: Its path is defined by *hadoop-data-node-configuration* configuration map.
* Data Storage: If  *${hadoop-data-node.storage_path}* specified, blocks are stored in these paths, 
                    otherwise in the *hdfs/data* directory under common storage path.
* Host Configuration: Its path is defined by *host-configuration* configuration map.
* Temp Data: It is in the *hadooptmp/datanode* directory under the storage path.

## Data Migration <a name="Data_Migration"></a>

HDFS support configure multipath.
If just need to expand current storage, you could keep current path and append a new disk as below:
1. Stop hadoop data node.
    ```bash
    python paictl.py service stop -n hadoop-data-node
    ```
2. Append new path in [services-configuration.yaml](../../examples/cluster-configuration/services-configuration.yaml) 
    *${hadoop-data-node.storage_path}*, such as "*${cluster.common.data-path}/hdfs/data*,*/path/to/new/disk*". 
    Then [push to configmap](../pai-management/doc/push-cfg-and-set-id.md).
3. Start hadoop data node.
    ```bash
    python paictl.py service start -n hadoop-data-node
    ```

Data migration is only necessary when discard old path. 
Please follow these steps to achieve it without data loss:
1. Confirm HDFS path in [services-configuration.yaml](../../examples/cluster-configuration/services-configuration.yaml), 
    it will be *${hadoop-data-node.storage_path}* if specified, 
    or *${cluster.common.data-path}/hdfs/data*. Assume current cluster HDFS path is *path1*, 
    new path is *path2*.
2. Stop hadoop data node.
    ```bash
    python paictl.py service stop -n hadoop-data-node
    ```
3. On every data node, manually copy data from *path1* to *path2*.
4. Edit [services-configuration.yaml](../../examples/cluster-configuration/services-configuration.yaml) *${hadoop-data-node.storage_path}* to *path2*, 
    and [push to configmap](../pai-management/doc/push-cfg-and-set-id.md).
5. Start hadoop data node.
    ```bash
    python paictl.py service start -n hadoop-data-node
    ```
6. Access HDFS web to confirm block status(by default *master_ip:5070*).
    If no missing block reported, you could remove the *path1* data on every data node now.
    

# Deployment <a name="Deployment"></a>

HDFS can be deployed when starting the OpenPAI services with command:
```bash
python paictl.py service start
```
The name node and data node service can be started separately by specifying the service name in the command.
```bash
python paictl.py service start -n hadoop-name-node
python paictl.py service start -n hadoop-data-node
```

# Upgrading <a name="Upgrading"></a>

It is recommended to have a backup of the name node data before upgrading the cluster.
Please refer [rolling upgrade](https://hadoop.apache.org/docs/r2.9.0/hadoop-project-dist/hadoop-hdfs/HdfsRollingUpgrade.html) for the detailed instructions.

# Service Monitoring <a name="Service_Monitoring"></a>

## Metrics <a name="Metrics"></a>
HDFS exposes various metrics for monitoring and debugging. Please refer [HDFS Metrics](https://hadoop.apache.org/docs/r2.9.0/hadoop-project-dist/hadoop-common/Metrics.html)
for all the detailed metrics and their explanations.

## Monitoring <a name="Monitoring"></a>

### Monitoring via Prometheus <a name="Monitoring_via_Prometheus"></a>

The Prometheus service will collect those metrics and monitor HDFS in real time. This is still an undergoing work.

### Monitoring via HTTP API <a name="Monitoring_via_HTTP_API"></a>

* Data Node: all the metrics can be retrieved by command
```bash
curl http://DATA_NODE_ADDRESS:5075/jmx
```

* Name Node: all the metrics can be retrieved by command
```bash
curl http://NAME_NODE_ADDRESS:5070/jmx
```

# High Availability <a name="High_Availability"></a>

Currently OpenPAI management tool doesn't deploy HDFS in a High Availability (HA) fashion. This will be added in a future release.
For solution about the HA feature please refer [HDFS High Availability](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HDFSHighAvailabilityWithNFS.html).

# Access HDFS Data <a name="Access_HDFS_Data"></a>

Data on HDFS can be accessed by various ways. Users can choose the proper way according to there needs.

Please refer to this [Access HDFS Data document](hdfs.md)

# Reference <a name="Reference"></a>

1. [Hadoop reference doc](https://hadoop.apache.org/docs/r2.9.0/)

# FAQ <a name="FAQ"></a>

1. Why cannot upload data to OpenPAI cluster deployed on Azure? -- [Issue 1664](https://github.com/Microsoft/pai/issues/1664) <br>
This can be caused by reason that the data node on Azure cannot be accessed directly by client since they only have internal IPs.
When uploading data to OpenPAI's HDFS, we recommend to use the WebHDFS restful API as described in [WebHDFS](#WebHDFS).
The restful API requests are redirected by Pylon so client don't need to access the data node directly. 

2. Why HDFS enters safemode? <br>
When cluster is starting up, name node will enter safemode to wait for data nodes to report the blocks and locations.
If the validation is finished, it will leave safemode automatically. HDFS can also enter safemode under unusual status.
If the disk is full or the blocks satisfying the minimum replication requirement is below the predefined percentage. 
The percentage threshold is configured by *dfs.namenode.safemode.threshold-pct* in *hdfs-site.xml* file. 
You can run following command ```hadoop dfsadmin -safemode leave``` to quit safemode forcefully.
