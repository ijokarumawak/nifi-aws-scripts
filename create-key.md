# create user private key and certificate
openssl req -x509 -newkey rsa:2048 \
 -keyout <user>.aws.mine.pem \
 -out <user>.aws.mine.crt \
 -days 365 \
 -nodes \
 -subj "/CN=<user>.aws.mine/C=JP/L=<user>.nifi.aws.mine"

# create local nifi private key and certificate
openssl req -x509 -newkey rsa:2048 \
 -keyout local-demo.pem \
 -out local-demo.crt \
 -days 365 \
 -nodes \
 -subj "/CN=localhost/C=JP/L=local-demo"

# create private key and certificate
k=0.b.nifi.aws.mine; \
openssl req -x509 -newkey rsa:2048 \
 -keyout $k.pem \
 -out $k.crt \
 -days 365 \
 -nodes \
 -subj "/CN=$k/C=US/L=$k"

# convert those into p12 key store file, in order to import those into java keytool keystore
k=0.b.nifi.aws.mine; \
openssl pkcs12 -export \
 -in $k.crt \
 -inkey $k.pem \
 -out $k.p12 \
 -passout pass:"pfxpassword" \
 -name $k

# import p12 into java keystore
k=0.b.nifi.aws.mine; \
keytool -importkeystore \
 -deststorepass keystorepass \
 -destkeypass keystorepass \
 -destkeystore $k-keystore.jks \
 -srckeystore $k.p12 \
 -srcstoretype PKCS12 \
 -srcstorepass pfxpassword -alias $k

# add nodes into truststore
i=<user>.aws.mine; \
k=0.b.nifi.aws.mine; \
keytool -importcert \
 -v -trustcacerts \
 -alias $i \
 -file $i.crt \
 -keystore $k-truststore.jks \
 -storepass truststorepass \
 -noprompt

# deploy keystore and truststore
scp ./0.b.nifi.aws.mine-*.jks ec2-user@0.b.nifi.aws.mine:/nifi/nifi-1.0.0-SNAPSHOT/

