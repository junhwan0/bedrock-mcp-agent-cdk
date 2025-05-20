#!/bin/bash
. ../conf/vpc-info

STACK_NAME=bedrock-agent-mcp-test-vpc

aws cloudformation create-stack \
    --stack-name $STACK_NAME \
    --template-body file://base-vpc.yaml \
    --capabilities CAPABILITY_IAM \
    --region $AWS_REGION

echo -e "Waiting for stack operation to complete..."
if aws cloudformation wait stack-create-complete --stack-name $STACK_NAME --region $AWS_REGION 2>/dev/null || \
   aws cloudformation wait stack-update-complete --stack-name $STACK_NAME --region $AWS_REGION 2>/dev/null; then
    echo -e "Stack operation completed successfully"
else
    echo -e "Stack operation failed"
    exit 1
fi