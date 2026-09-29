#include <Arduino.h>
#include <HardwareSerial.h>
#include <LittleFS.h>
#include <ArduinoJson.h>

// ============================================================
// CONFIG
// ============================================================

#define CONFIG_FILE "/config.json"

HardwareSerial RS485(2);

JsonDocument config;

// ============================================================
// CRC16 MODBUS
// ============================================================

uint16_t modbusCRC(uint8_t *data, uint16_t length)
{
    uint16_t crc = 0xFFFF;

    for (uint16_t pos = 0; pos < length; pos++)
    {
        crc ^= data[pos];

        for (uint8_t i = 0; i < 8; i++)
        {
            if (crc & 0x0001)
                crc = (crc >> 1) ^ 0xA001;
            else
                crc >>= 1;
        }
    }

    return crc;
}

// ============================================================
// RS485 DIRECTION
// ============================================================

void rs485TxMode()
{
    int pin = config["rs485"]["de_re_pin"] | -1;

    if (pin >= 0)
        digitalWrite(pin, HIGH);
}

void rs485RxMode()
{
    int pin = config["rs485"]["de_re_pin"] | -1;

    if (pin >= 0)
        digitalWrite(pin, LOW);
}

// ============================================================
// ADDRESS
// ============================================================

uint16_t parseAddress(const char *address)
{
    if (address == nullptr)
        return 0;

    return (uint16_t)strtoul(
        address,
        nullptr,
        0
    );
}

// ============================================================
// SERIAL CONFIGURATION
// ============================================================

uint32_t getSerialConfig(
    const char *parity,
    int dataBits,
    int stopBits
)
{
    char p = 'N';

    if (parity != nullptr)
        p = toupper(parity[0]);

    if (dataBits == 7)
    {
        if (stopBits == 2)
        {
            if (p == 'E')
                return SERIAL_7E2;

            if (p == 'O')
                return SERIAL_7O2;

            return SERIAL_7N2;
        }

        if (p == 'E')
            return SERIAL_7E1;

        if (p == 'O')
            return SERIAL_7O1;

        return SERIAL_7N1;
    }

    // 8 data bits

    if (stopBits == 2)
    {
        if (p == 'E')
            return SERIAL_8E2;

        if (p == 'O')
            return SERIAL_8O2;

        return SERIAL_8N2;
    }

    if (p == 'E')
        return SERIAL_8E1;

    if (p == 'O')
        return SERIAL_8O1;

    return SERIAL_8N1;
}

// ============================================================
// LOAD CONFIG
// ============================================================

bool loadConfig()
{
    if (!LittleFS.begin(true))
    {
        Serial.println(
            "ERROR: LittleFS mount failed"
        );

        return false;
    }

    Serial.println(
        "LittleFS mounted"
    );

    if (!LittleFS.exists(CONFIG_FILE))
    {
        Serial.println(
            "ERROR: config.json not found"
        );

        return false;
    }

    File file =
        LittleFS.open(
            CONFIG_FILE,
            "r"
        );

    if (!file)
    {
        Serial.println(
            "ERROR: cannot open config.json"
        );

        return false;
    }

    DeserializationError error =
        deserializeJson(
            config,
            file
        );

    file.close();

    if (error)
    {
        Serial.print(
            "ERROR: JSON parse failed: "
        );

        Serial.println(
            error.c_str()
        );

        return false;
    }

    Serial.println(
        "Configuration loaded"
    );

    return true;
}

// ============================================================
// CONFIGURE RS485 FOR SENSOR
// ============================================================

void configureRS485(JsonObject modbus)
{
    int rxPin =
        config["rs485"]["rx_pin"] | 13;

    int txPin =
        config["rs485"]["tx_pin"] | 14;

    int deRePin =
        config["rs485"]["de_re_pin"] | -1;

    int baud =
        modbus["baud_rate"] | 9600;

    const char *parity =
        modbus["parity"] | "N";

    int dataBits =
        modbus["data_bits"] | 8;

    int stopBits =
        modbus["stop_bits"] | 1;

    uint32_t serialConfig =
        getSerialConfig(
            parity,
            dataBits,
            stopBits
        );

    if (deRePin >= 0)
    {
        pinMode(
            deRePin,
            OUTPUT
        );

        digitalWrite(
            deRePin,
            LOW
        );
    }

    RS485.end();

    delay(5);

    RS485.begin(
        baud,
        serialConfig,
        rxPin,
        txPin
    );

    rs485RxMode();
}

// ============================================================
// READ MODBUS REGISTERS
// ============================================================

bool readRegisters(
    uint8_t slaveId,
    uint8_t functionCode,
    uint16_t address,
    uint16_t quantity,
    uint16_t *registers,
    uint16_t timeout
)
{
    if (quantity == 0)
        return false;

    uint8_t request[8];

    request[0] = slaveId;
    request[1] = functionCode;

    request[2] =
        (uint8_t)(address >> 8);

    request[3] =
        (uint8_t)(address & 0xFF);

    request[4] =
        (uint8_t)(quantity >> 8);

    request[5] =
        (uint8_t)(quantity & 0xFF);

    uint16_t crc =
        modbusCRC(
            request,
            6
        );

    request[6] =
        crc & 0xFF;

    request[7] =
        crc >> 8;

    // --------------------------------------------------------
    // CLEAR RX BUFFER
    // --------------------------------------------------------

    while (RS485.available())
        RS485.read();

    // --------------------------------------------------------
    // TRANSMIT
    // --------------------------------------------------------

    rs485TxMode();

    RS485.write(
        request,
        8
    );

    RS485.flush();

    delayMicroseconds(100);

    rs485RxMode();

    // --------------------------------------------------------
    // EXPECTED RESPONSE
    // ID + FUNCTION + BYTE COUNT
    // DATA + CRC
    // --------------------------------------------------------

    uint16_t expectedBytes =
        3 +
        (quantity * 2) +
        2;

    if (expectedBytes > 250)
        return false;

    uint8_t response[250];

    uint16_t index = 0;

    uint32_t start =
        millis();

    while (index < expectedBytes)
    {
        if (RS485.available())
        {
            response[index++] =
                RS485.read();
        }
        else
        {
            if (
                millis() - start >
                timeout
            )
            {
                return false;
            }

            delay(1);
        }
    }

    // --------------------------------------------------------
    // SLAVE ID
    // --------------------------------------------------------

    if (response[0] != slaveId)
    {
        return false;
    }

    // --------------------------------------------------------
    // EXCEPTION
    // --------------------------------------------------------

    if (response[1] & 0x80)
    {
        Serial.printf(
            "Modbus exception: 0x%02X\n",
            response[2]
        );

        return false;
    }

    // --------------------------------------------------------
    // FUNCTION
    // --------------------------------------------------------

    if (response[1] != functionCode)
    {
        return false;
    }

    // --------------------------------------------------------
    // BYTE COUNT
    // --------------------------------------------------------

    if (
        response[2] !=
        quantity * 2
    )
    {
        return false;
    }

    // --------------------------------------------------------
    // CRC
    // --------------------------------------------------------

    uint16_t receivedCRC =
        response[expectedBytes - 2] |
        (
            (uint16_t)
            response[expectedBytes - 1]
            << 8
        );

    uint16_t calculatedCRC =
        modbusCRC(
            response,
            expectedBytes - 2
        );

    if (
        receivedCRC !=
        calculatedCRC
    )
    {
        Serial.println(
            "CRC error"
        );

        return false;
    }

    // --------------------------------------------------------
    // COPY REGISTERS
    // --------------------------------------------------------

    for (
        uint16_t i = 0;
        i < quantity;
        i++
    )
    {
        registers[i] =
            (
                (uint16_t)
                response[3 + i * 2]
                << 8
            ) |
            response[4 + i * 2];
    }

    return true;
}

// ============================================================
// READ CHANNEL
// ============================================================

bool readChannel(
    JsonObject channel,
    JsonObject modbus,
    float &value
)
{
    const char *addressString =
        channel["address"] | "0x00";

    uint16_t address =
        parseAddress(
            addressString
        );

    uint16_t width =
        channel["width"] | 1;

    float scale =
        channel["scale_factor"] | 1.0;

    uint8_t slaveId =
        modbus["slave_id"] | 1;

    uint16_t timeout =
        modbus["receive_timeout_ms"] | 200;

    int retries =
        modbus["retry_attempts"] | 3;

    const char *registerType =
        channel["register_type"] |
        "input";

    uint8_t functionCode = 0x04;

    if (
        strcmp(
            registerType,
            "holding"
        ) == 0
    )
    {
        functionCode = 0x03;
    }

    // --------------------------------------------------------
    // MAX TWO REGISTERS FOR CURRENT IMPLEMENTATION
    // --------------------------------------------------------

    if (width < 1 || width > 2)
    {
        Serial.println(
            "Unsupported register width"
        );

        return false;
    }

    uint16_t registers[2] = {0, 0};

    // --------------------------------------------------------
    // RETRIES
    // --------------------------------------------------------

    for (
        int attempt = 1;
        attempt <= retries;
        attempt++
    )
    {
        if (
            readRegisters(
                slaveId,
                functionCode,
                address,
                width,
                registers,
                timeout
            )
        )
        {
            const char *dataType =
                channel["data_type"] |
                "uint16";

            float result = 0;

            // =================================================
            // UINT16
            // =================================================

            if (
                strcmp(
                    dataType,
                    "uint16"
                ) == 0
            )
            {
                result =
                    (float)registers[0];
            }

            // =================================================
            // INT16
            // =================================================

            else if (
                strcmp(
                    dataType,
                    "int16"
                ) == 0
            )
            {
                int16_t temp =
                    (int16_t)registers[0];

                result =
                    (float)temp;
            }

            // =================================================
            // UINT32
            // =================================================

            else if (
                strcmp(
                    dataType,
                    "uint32"
                ) == 0
            )
            {
                if (width != 2)
                    return false;

                uint32_t raw;

                const char *wordOrder =
                    channel["word_order"] |
                    "high_low";

                if (
                    strcmp(
                        wordOrder,
                        "low_high"
                    ) == 0
                )
                {
                    raw =
                        (
                            (uint32_t)
                            registers[1]
                            << 16
                        ) |
                        registers[0];
                }
                else
                {
                    raw =
                        (
                            (uint32_t)
                            registers[0]
                            << 16
                        ) |
                        registers[1];
                }

                result =
                    (float)raw;
            }

            // =================================================
            // INT32
            // =================================================

            else if (
                strcmp(
                    dataType,
                    "int32"
                ) == 0
            )
            {
                if (width != 2)
                    return false;

                uint32_t raw;

                const char *wordOrder =
                    channel["word_order"] |
                    "high_low";

                if (
                    strcmp(
                        wordOrder,
                        "low_high"
                    ) == 0
                )
                {
                    raw =
                        (
                            (uint32_t)
                            registers[1]
                            << 16
                        ) |
                        registers[0];
                }
                else
                {
                    raw =
                        (
                            (uint32_t)
                            registers[0]
                            << 16
                        ) |
                        registers[1];
                }

                int32_t signedValue =
                    (int32_t)raw;

                result =
                    (float)signedValue;
            }

            // =================================================
            // FLOAT32
            // =================================================

            else if (
                strcmp(
                    dataType,
                    "float32"
                ) == 0
            )
            {
                if (width != 2)
                    return false;

                uint32_t raw;

                const char *wordOrder =
                    channel["word_order"] |
                    "low_high";

                if (
                    strcmp(
                        wordOrder,
                        "high_low"
                    ) == 0
                )
                {
                    raw =
                        (
                            (uint32_t)
                            registers[0]
                            << 16
                        ) |
                        registers[1];
                }
                else
                {
                    raw =
                        (
                            (uint32_t)
                            registers[1]
                            << 16
                        ) |
                        registers[0];
                }

                memcpy(
                    &result,
                    &raw,
                    sizeof(result)
                );
            }

            else
            {
                Serial.printf(
                    "Unsupported data type: %s\n",
                    dataType
                );

                return false;
            }

            value =
                result * scale;

            return true;
        }

        delay(20);
    }

    return false;
}

// ============================================================
// PRINT CHANNEL
// ============================================================

void printChannel(
    JsonObject channel,
    JsonObject modbus
)
{
    bool enabled =
        channel["enabled"] | false;

    if (!enabled)
        return;

    const char *alias =
        channel["alias"] |
        "unknown";

    const char *unit =
        channel["unit"] |
        "";

    const char *address =
        channel["address"] |
        "0x00";

    float value = 0;

    bool success =
        readChannel(
            channel,
            modbus,
            value
        );

    if (!success)
    {
        Serial.printf(
            "%-22s : ERROR [%s]\n",
            alias,
            address
        );

        return;
    }

    if (strlen(unit) > 0)
    {
        Serial.printf(
            "%-22s : %.3f %s\n",
            alias,
            value,
            unit
        );
    }
    else
    {
        Serial.printf(
            "%-22s : %.3f\n",
            alias,
            value
        );
    }
}

// ============================================================
// READ SENSOR
// ============================================================

void readSensor(JsonObject sensor)
{
    int sensorId =
        sensor["id"] | 0;

    const char *sensorName =
        sensor["name"] |
        "Unknown Sensor";

    JsonObject modbus =
        sensor["modbus"];

    int slaveId =
        modbus["slave_id"] | 1;

    int baud =
        modbus["baud_rate"] | 9600;

    const char *parity =
        modbus["parity"] | "N";

    // --------------------------------------------------------
    // CONFIGURE UART FOR THIS SENSOR
    // --------------------------------------------------------

    configureRS485(
        modbus
    );

    Serial.println();

    Serial.println(
        "======================================"
    );

    Serial.printf(
        "Sensor : %s\n",
        sensorName
    );

    Serial.printf(
        "ID     : %d\n",
        sensorId
    );

    Serial.printf(
        "Slave  : %d\n",
        slaveId
    );

    Serial.printf(
        "Baud   : %d\n",
        baud
    );

    Serial.printf(
        "Parity : %s\n",
        parity
    );

    Serial.println(
        "======================================"
    );

    // --------------------------------------------------------
    // CHANNELS
    // --------------------------------------------------------

    JsonArray channels =
        sensor["channels"];

    for (
        JsonObject channel :
        channels
    )
    {
        printChannel(
            channel,
            modbus
        );

        delay(30);
    }

    Serial.println(
        "--------------------------------------"
    );
}

// ============================================================
// SETUP
// ============================================================

void setup()
{
    Serial.begin(115200);

    delay(1000);

    Serial.println();

    Serial.println(
        "======================================"
    );

    Serial.println(
        "     ESP32 MODBUS SENSOR GATEWAY"
    );

    Serial.println(
        "======================================"
    );

    // --------------------------------------------------------
    // LOAD CONFIG
    // --------------------------------------------------------

    if (!loadConfig())
    {
        Serial.println(
            "CONFIG ERROR"
        );

        while (true)
            delay(1000);
    }

    int version =
        config["config_version"] | 0;

    Serial.printf(
        "Config version: %d\n",
        version
    );

    int rxPin =
        config["rs485"]["rx_pin"] |
        13;

    int txPin =
        config["rs485"]["tx_pin"] |
        14;

    int deRePin =
        config["rs485"]["de_re_pin"] |
        -1;

    Serial.printf(
        "RS485 RX      : GPIO%d\n",
        rxPin
    );

    Serial.printf(
        "RS485 TX      : GPIO%d\n",
        txPin
    );

    Serial.printf(
        "RS485 DE/RE   : %d\n",
        deRePin
    );

    Serial.println();

    Serial.println(
        "System ready"
    );
}

// ============================================================
// LOOP
// ============================================================

void loop()
{
    JsonArray sensors =
        config["sensors"];

    // --------------------------------------------------------
    // READ EVERY SENSOR
    // --------------------------------------------------------

    for (
        JsonObject sensor :
        sensors
    )
    {
        readSensor(
            sensor
        );
    }

    // --------------------------------------------------------
    // GLOBAL POLLING INTERVAL
    // --------------------------------------------------------

    uint32_t interval =
        config["device"]
               ["poll_interval_ms"]
        | 2000;

    delay(interval);
}
