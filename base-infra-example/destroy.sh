#!/bin/bash
STACK_NAME=bedrock-agent-mcp-test-vpc

aws cloudformation delete-stack \
    --stack-name $STACK_NAME \
    --region $AWS_REGION