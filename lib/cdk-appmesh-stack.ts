import * as cdk from '@aws-cdk/core';
import * as appmesh from "@aws-cdk/aws-appmesh"
import * as ecs from "@aws-cdk/aws-ecs";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecr from "@aws-cdk/aws-ecr";
import * as log from "@aws-cdk/aws-logs";
import * as servicediscovery from "@aws-cdk/aws-servicediscovery";

export class CdkAppmeshStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const serviceName = "sample-app"
    const portNumber = 80
    
    const vpc = new ec2.Vpc(this, "vpc", {
      natGateways: 0,
      subnetConfiguration: [ 
        { 
          subnetType: ec2.SubnetType.PUBLIC,
          name: "public"
        }
      ]
    })
    new ec2.BastionHostLinux(this, "instance", { vpc })

    const cluster = new ecs.Cluster(this, "cluster", {
      vpc: vpc,
      clusterName: "appmesh-test",
    })
    const cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(this, "test", {
      vpc,
      name: "ins-internal"
    })

    // const mesh = appmesh.Mesh.fromMeshName(this, "mesh", "exp")
    const mesh = new appmesh.Mesh(this, "mesh")

    // タスク定義の作成
    const taskDefinition = new ecs.FargateTaskDefinition(this, "taskdef", {
      family: "appmesh-test",
      proxyConfiguration: new ecs.AppMeshProxyConfiguration({
        containerName: "envoy",
        properties: {
          appPorts: [portNumber],
          proxyEgressPort: 15001,
          proxyIngressPort: 15000,
          ignoredUID: 1337,
          egressIgnoredIPs: [
            "169.254.170.2",
            "169.254.169.254"
          ]
        }
      })
    })

    // log
    const logGroup = new log.LogGroup(this, "appmesh-test-log", {
      logGroupName: "/ecs/appmeshtest",
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    // app container
    const app = taskDefinition.addContainer("app", {
      image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${serviceName}-app`,
        logGroup
      })
    })
    app.addPortMappings({
      containerPort: portNumber,
      hostPort: portNumber
    })

    // envoy container
    const appMeshRepo = ecr.Repository.fromRepositoryAttributes(this, "envoy-repo",{
      repositoryName: 'aws-appmesh-envoy',
      repositoryArn: `arn:aws:ecr:ap-northeast-1:840364872350:repository/aws-appmesh-envoy`,
    })
    taskDefinition.addContainer("envoy", {
      image: ecs.ContainerImage.fromEcrRepository(appMeshRepo, "v1.15.1.0-prod"),
      essential: true,
      environment: {
        APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh.meshName}/virtualNode/${serviceName}`,
        AWS_REGION: cdk.Stack.of(this).region
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'
        ],
        startPeriod: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        retries: 3
      },
      memoryLimitMiB: 128,
      user: "1337",
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${serviceName}-envoy`,
        logGroup
      })
    })

    // fargate
    const fargateSg = new ec2.SecurityGroup(this, "fargate-sg", { vpc })
    fargateSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80))
    
    const fargate = new ecs.FargateService(this, `${serviceName}-service`, {
      cluster,
      taskDefinition,
      securityGroups: [fargateSg],
      assignPublicIp: true,
      cloudMapOptions: {
        dnsTtl: cdk.Duration.seconds(10),
        failureThreshold: 2,
        name: serviceName,
        cloudMapNamespace
      }
    })

    const virtualNode = new appmesh.VirtualNode(this, `${serviceName}-virtual-node`, {
      mesh,
      virtualNodeName: serviceName,
      serviceDiscovery: appmesh.ServiceDiscovery.dns(cloudMapNamespace.namespaceName),
      listeners: [ 
        appmesh.VirtualNodeListener.http({
          port: portNumber,
          healthCheck: appmesh.HealthCheck.http({
            healthyThreshold: 3,
            interval: cdk.Duration.millis(10000),
            path: "/",
            timeout: cdk.Duration.millis(5000),
            unhealthyThreshold: 3
          })
        })
      ]
    })

    const virtualRouter = new appmesh.VirtualRouter(this, "${serviceName}-virtual-router", {
      mesh,
      listeners: [ appmesh.VirtualRouterListener.http(portNumber) ],
      virtualRouterName: `${serviceName}`
    })
    const weightedTargets: appmesh.WeightedTarget[] = [{
      virtualNode,
      weight: 1,
    }]

    virtualRouter.addRoute("route", {
      routeSpec: appmesh.RouteSpec.http({ weightedTargets }),
      routeName: `${serviceName}`
    })

    new appmesh.VirtualService(this, `${serviceName}-virtual-service`, {
      virtualServiceName: `${serviceName}`,
      virtualServiceProvider: appmesh.VirtualServiceProvider.virtualRouter(virtualRouter)
    })
  }
}